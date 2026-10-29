---
rel_path: "evidence/idop-p001-architect-raw-catalog-20261029-fire47.json"
updated_at: 1793246504873
_body: "content"
---

{
  "schemaVersion": 1,
  "kind": "bounded-actual-architect-sdk-catalog-with-native-provenance",
  "plan": "identity-definitions-own-policy-2026-10-17",
  "workItem": "WI-6554700010017386",
  "fire": 47,
  "capturedAt": "2026-10-29T04:01:40.596844+00:00",
  "acceptance": "OPEN",
  "canonicalAcceptance": false,
  "rawCatalog": {
    "path": "/tmp/idop-p001-architect-actual-catalog-fire47.json",
    "bytes": 584041,
    "sha256": "941c8e4220855b6bd788e42c64192a7da6eaf845ec94f9936f0197dd0156bea7",
    "observation": {
      "schemaVersion": 1,
      "kind": "actual-caller-sdk-catalog",
      "startedAt": "2026-10-29T03:57:04.306Z",
      "completedAt": "2026-10-29T03:57:06.951Z",
      "caller": {
        "ownerId": "su-f767a5c2-69cd-4c73-8e9e-6387e8e826c2",
        "nativeSessionId": "01a185cd-a670-7a90-89a2-31afe44c2fd3",
        "configuredRole": "architect",
        "workspace": "papercusp-workspace",
        "harness": "papercusp",
        "configSha256": "21611e224fe320703d57623607a86700b870d5ee01225f9717f19bdcf696dbed",
        "endpointSha256": "dad0596ad4f65e24a96cc58c1677ed5879f72977da522df58ad8dabf8878800a",
        "endpointOrigin": "http://127.0.0.1:9171",
        "endpointPath": "/api/mcp"
      },
      "transportKind": "http",
      "complete": true,
      "failure": null,
      "pages": [
        {
          "capturedAt": "2026-10-29T03:57:06.936Z",
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
                "name": "coord:inbox",
                "description": "Read messages, acks, and handoffs addressed to you or broadcast. `limit` bounds a priority-ranked window (not newest-first); `coord:orient.inboxLimit` maps to it. Default: what fits one result. Ambient broadcasts require include_ambient. Repeats collapse (`repeat_count`, `first_seen_ts`); ignore resolved:true alarms; follow superseded_by corrections. Supported narrowing filters are `kinds`, `from`, and `unanswered_only` (alias `unansweredOnly`). The `kinds` filter accepts canonical `CoordKind` wire values only: subscribe, unsubscribe, notify, handoff, handoff_accepted, handoff_expired, handoff_repinged, contract, plan_event, yield, message, ack, unack, escalation, escalation_resolved, escalation_reopened, presence_alert. `interrupt` is conceptual language for actionable coordination traffic, not a `kinds` value; a cooperative turn-interrupt/wrap-up is encoded as the canonical executable kind `yield`. `recent` holds msg_ids into `entries`. An inbox read (also via coord:orient) clears the unread-mail reminder; FYIs (expects:none) need no reply. Reading does not fulfill ack/answer/action requests. This is a VIEW: re-reading does not empty it.",
                "inputSchema": {
                  "type": "object",
                  "properties": {
                    "kinds": {
                      "type": "array",
                      "items": {
                        "type": "string",
                        "enum": [
                          "subscribe",
                          "unsubscribe",
                          "notify",
                          "handoff",
                          "handoff_accepted",
                          "handoff_expired",
                          "handoff_repinged",
                          "contract",
                          "plan_event",
                          "yield",
                          "message",
                          "ack",
                          "unack",
                          "escalation",
                          "escalation_resolved",
                          "escalation_reopened",
                          "presence_alert"
                        ]
                      }
                    },
                    "from": {
                      "description": "Restrict to entries SENT BY this ownerId (from === this) — e.g. filter to just your leader's messages amid broadcast/doc-drift noise, or confirm a specific peer wrote to you. Applied after the ambient filter; the summary counts reflect it. (EI-7018)",
                      "type": "string"
                    },
                    "limit": {
                      "description": "Max entries in the priority-ranked window; newest-first overall is not guaranteed. Default: what fits one result, max 50.",
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 500
                    },
                    "include_ambient": {
                      "description": "Include ambient system broadcasts (service-health, agent-governor, doc-drift) excluded by default.",
                      "type": "boolean"
                    },
                    "include_intents": {
                      "description": "Include peers' auto `now working on:` intent-declare messages (lifecycle:'intent'), excluded from the default read like ambient — they are presence state, re-broadcast to every plan/fleet subscriber, and on a busy fleet they dominate the window (P-005 fleet-member-dx: 2,300+ of one member's inbox). summary.intent_excluded counts them. A `from`-filtered read keeps them regardless (a sender-scoped read wants that sender's status).",
                      "type": "boolean"
                    },
                    "max_body_chars": {
                      "description": "Truncate each entry's body/summary/sections text to this many chars in the result (default dynamically budgets to roughly 15KB across entries) so a default read never overflows the agent result cap; truncated entries carry *_truncated:true and the full body is reachable via coord:read { msg_id } (or coord:thread). 0 = no truncation. An explicit payloadTier:'full' request also disables this field-level cap unless max_body_chars is supplied.",
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    },
                    "unanswered_only": {
                      "description": "EI-13159: narrow to exactly the DIRECTED messages still awaiting your reply — the same unanswered-directed definition fleet:assignments' `unanswered_directed` counter and fleet:leader-brief use (a real correspondent's message, sender explicitly expects a reply, no ack/reply from you yet; excludes broadcasts, machine chatter, and reply-to-your-own-reply ping-pong). Applied after the ambient/intent/sender filters; summary.total reflects it. A lookup failure returns zero entries (never silently falls back to the unfiltered inbox) and sets summary.unanswered_lookup_failed:true.",
                      "type": "boolean"
                    },
                    "directed": {
                      "description": "Narrow to entries addressed to a SPECIFIC recipient — i.e. drop entries broadcast to everyone (`to:['*']`); mixed `['*', you]` delivery counts as directed. Weaker than `unanswered_only`, which additionally requires that the sender expects a reply you have not sent: use `directed` for \"who wrote to ME\" (including messages you have already answered) and `unanswered_only` for \"what still needs my reply\". Applied after the ambient/intent/sender filters; summary.total reflects it and summary.broadcast_excluded counts what it dropped.",
                      "type": "boolean"
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
                  "papercusp/servingGeneration": "serving-generation-v1:a528040778992a8ce2dda4696ff0affe43345629ae38c3e3ff7732a35db2389c"
                }
              },
              {
                "name": "coord:glance",
                "description": "Fleet status and tips. One combined view of wake mode (default) + staged-wake count, bees in flight (bees.running = fresh-heartbeat nursery rows, may include parked/idle sessions; bees.working = confirmed-active subset with fresh child-stdout output — prefer it for health checks), paused governor buckets, recent cross-CLI activity rows, and contextual tips (with ready-to-run slash commands) evaluated for the caller's audience. With audience 'user' also returns a server-rendered `display` block (title + statusline lines + tip notice) that client status surfaces print verbatim — the single-source TUI render. Statusline/TUI read — one call instead of four. Takes ONLY audience/state/activity_limit/display_only — no `fleet`, `workspace`, or `harness` arg (scope is inferred from context); use fleet:assignments or fleet:leader-brief for named-fleet health.",
                "inputSchema": {
                  "type": "object",
                  "properties": {
                    "audience": {
                      "description": "Who is looking — scopes which tips apply. Default 'user' (a human status surface).",
                      "type": "string",
                      "enum": [
                        "user",
                        "mug",
                        "su",
                        "cup"
                      ]
                    },
                    "state": {
                      "description": "Free-form caller state pairs for tip rules to match on (e.g. view=fleet-tab).",
                      "type": "object",
                      "propertyNames": {
                        "type": "string"
                      },
                      "additionalProperties": {
                        "type": "string",
                        "maxLength": 200
                      }
                    },
                    "activity_limit": {
                      "description": "Recent activity rows to include (default 12; 0 to skip).",
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 100
                    },
                    "display_only": {
                      "description": "For human status surfaces that only print display.title/statusline/notice: compute display normally, but omit raw activity rows from the returned payload.",
                      "type": "boolean"
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
                  "papercusp/servingGeneration": "serving-generation-v1:a528040778992a8ce2dda4696ff0affe43345629ae38c3e3ff7732a35db2389c"
                }
              },
              {
                "name": "activity:report",
                "description": "Report one worker-activity event (a native tool call, lifecycle transition, or todo snapshot) to the cross-CLI activity bridge sink (harness_shared.agent_activity). Called by the per-CLI hooks on every tool call; feeds the pui fleet view + curator. The display summary is derived server-side from tool_name+tool_input when not supplied. Fire-and-forget: returns { ok, id } and never blocks.",
                "inputSchema": {
                  "type": "object",
                  "properties": {
                    "owner": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 256
                    },
                    "agent": {
                      "type": "string",
                      "maxLength": 32
                    },
                    "role": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 80
                    },
                    "session_id": {
                      "$ref": "#/$defs/1"
                    },
                    "adv_session_id": {
                      "$ref": "#/$defs/0"
                    },
                    "agent_task_id": {
                      "type": "string",
                      "pattern": "^[0-9a-z]{19}$"
                    },
                    "wake_delivery_id": {
                      "$ref": "#/$defs/0"
                    },
                    "harness_slug": {
                      "$ref": "#/$defs/1"
                    },
                    "kind": {
                      "type": "string",
                      "enum": [
                        "tool",
                        "lifecycle",
                        "todos"
                      ]
                    },
                    "tool_name": {
                      "type": "string",
                      "maxLength": 128
                    },
                    "phase": {
                      "type": "string",
                      "enum": [
                        "pre",
                        "post"
                      ]
                    },
                    "tool_use_id": {
                      "$ref": "#/$defs/1"
                    },
                    "tool_input": {
                      "type": "object",
                      "propertyNames": {
                        "type": "string"
                      },
                      "additionalProperties": {}
                    },
                    "todos": {
                      "maxItems": 100,
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "content": {
                            "type": "string"
                          },
                          "status": {
                            "type": "string"
                          },
                          "activeForm": {
                            "type": "string"
                          }
                        },
                        "additionalProperties": false
                      }
                    },
                    "summary": {
                      "type": "string",
                      "maxLength": 512
                    },
                    "status": {
                      "type": "string",
                      "maxLength": 32
                    },
                    "cwd": {
                      "type": "string",
                      "maxLength": 1024
                    },
                    "hook_fallbacks": {
                      "maxItems": 64,
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "eligible": {
                            "type": "number",
                            "const": 1
                          },
                          "applied": {
                            "anyOf": [
                              {
                                "type": "number",
                                "const": 0
                              },
                              {
                                "type": "number",
                                "const": 1
                              }
                            ]
                          },
                          "reason": {
                            "type": "string",
                            "enum": [
                              "lock-keys-empty",
                              "lock-request-refused",
                              "lock-transport-unavailable",
                              "applied"
                            ]
                          },
                          "observed_at": {
                            "type": "string",
                            "format": "date-time",
                            "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
                          }
                        },
                        "required": [
                          "eligible",
                          "applied",
                          "reason",
                          "observed_at"
                        ],
                        "additionalProperties": false
                      }
                    },
                    "hook_bundle": {
                      "type": "object",
                      "properties": {
                        "generation": {
                          "anyOf": [
                            {
                              "$ref": "#/$defs/1"
                            },
                            {
                              "type": "null"
                            }
                          ]
                        },
                        "since_ts": {
                          "anyOf": [
                            {
                              "type": "string",
                              "maxLength": 128
                            },
                            {
                              "type": "null"
                            }
                          ]
                        },
                        "force_resync": {
                          "type": "boolean"
                        },
                        "glance_stale": {
                          "type": "boolean"
                        }
                      },
                      "additionalProperties": false
                    }
                  },
                  "additionalProperties": false,
                  "$defs": {
                    "0": {
                      "type": "integer",
                      "exclusiveMinimum": 0,
                      "maximum": 9007199254740991
                    },
                    "1": {
                      "type": "string",
                      "maxLength": 256
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
                "name": "search:fulltext",
                "description": "Search workspace prose by keyword (BM25-style). Plans, including drafts, are included by default and alongside work_item searches. Plan results expose plan_status. Returns ranked excerpts and unsearched-corpus disclosure.",
                "inputSchema": {
                  "type": "object",
                  "properties": {
                    "query": {
                      "default": "",
                      "type": "string",
                      "maxLength": 500
                    },
                    "promotedFrom": {
                      "description": "Exact reverse lookup of facts, docs and plan decisions promoted from this source. No text query or inference required.",
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
                    "scope": {
                      "type": "array",
                      "items": {
                        "type": "string",
                        "enum": [
                          "escalations",
                          "brainstorm",
                          "turns",
                          "decisions",
                          "work_item",
                          "session_turn",
                          "coord_message",
                          "report",
                          "plan",
                          "doc",
                          "all"
                        ]
                      }
                    },
                    "harness_slug": {
                      "type": "string"
                    },
                    "limit": {
                      "description": "Max results (default 5; maximum 50).",
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 50
                    },
                    "owner": {
                      "description": "Restrict to turns/messages attributed to one agent ownerId. Pass 'self' for the calling agent.",
                      "type": "string",
                      "maxLength": 120
                    },
                    "fleet": {
                      "description": "Restrict to agents who were EVER members of this fleet (resolved from the append-only membership ledger — includes dead/ended members; a postmortem-safe filter).",
                      "type": "string",
                      "maxLength": 80
                    },
                    "speaker": {
                      "description": "Restrict transcript hits to one side of the conversation.",
                      "type": "string",
                      "enum": [
                        "user",
                        "assistant"
                      ]
                    },
                    "turn_origin": {
                      "description": "Restrict transcript hits to the PERSISTED turn-origin verdict — which is stricter than the verdict a hit DISPLAYS. For file-backed CLI sessions (claude/omp/codex), an uncorrelated typed prompt remains 'unenrolled-origin' because a clean CLI row proves neither owner nor machine authorship. A hook-authenticated prompt-origin stamp can correlate the exact row by source, session, prompt hash, and time (currently Claude hook stamps), upgrading it to persisted 'owner-typed'. This filter can therefore match exact authenticated rows but may be sparse; a zero is NOT evidence that the owner said nothing. For recall of residual candidates use owner_candidates:true, then read each hit before attributing it.",
                      "type": "string",
                      "enum": [
                        "owner-typed",
                        "owner-dialog",
                        "agent-injected",
                        "machine-surface",
                        "synthetic",
                        "unenrolled-origin",
                        "not-user-turn"
                      ]
                    },
                    "owner_only": {
                      "description": "Restrict hits to turns whose authorship is PROVEN owner speech (persisted 'owner-typed' or 'owner-dialog'). High precision, very low recall: file-backed CLI typed directives remain 'unenrolled-origin' when no matching hook-authenticated prompt-origin stamp exists, but an exact authenticated row can be persisted as 'owner-typed'. A zero here is NOT evidence the owner said nothing — use owner_candidates:true to recall residual candidates.",
                      "type": "boolean"
                    },
                    "owner_candidates": {
                      "description": "Widen to turns that COULD be owner speech: proven owner turns PLUS 'unenrolled-origin' — the bucket a typed owner directive lands in on file-backed sessions when no matching hook-authenticated prompt-origin stamp exists; exact matched rows are promoted to persisted 'owner-typed' and are already included by owner_only. Use it for RECALL when owner_only returns a sparse or residual-only result. ⚠ CANDIDATES, NOT PROOF, and the gap is large: 'unenrolled-origin' means only 'no machine envelope was found', which is also true of machine text that never carried one. Measured 2026-08-24 over 13,917 real claude rows, at least 7,637 (55%) are machine-shaped — Kettle/Mug system prompts, '[await-event] … fired' wake injections, '/compact …' directives, harness retry text — sitting beside genuine owner turns. So a hit here is a CANDIDATE to read, never evidence on its own, and a NON-empty result is not confirmation any more than an empty one is denial. Read each hit's provenance and its text before attributing anything to the owner. What this filter does buy is real but bounded: it drops the ~112k rows PROVABLY machine (agent-injected, machine-surface) plus assistant turns, so the loop-fire replays that make an unfiltered search read an agent's own words back as the owner's are gone.",
                      "type": "boolean"
                    },
                    "session": {
                      "description": "Restrict to one session id. Pass 'self' for the calling agent's CURRENT session — your pre-compaction turns are searchable this way (they survive on disk).",
                      "type": "string",
                      "maxLength": 200
                    },
                    "source_kind": {
                      "description": "Restrict transcript hits to one client/source.",
                      "type": "string",
                      "enum": [
                        "claude",
                        "omp",
                        "codex",
                        "agent_chat"
                      ]
                    },
                    "since": {
                      "description": "ISO timestamp lower bound (inclusive).",
                      "type": "string",
                      "maxLength": 40
                    },
                    "until": {
                      "description": "ISO timestamp upper bound (exclusive).",
                      "type": "string",
                      "maxLength": 40
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
                "name": "loop:arm",
                "description": "Arm the tracked engine loop for your session (or another ownerId) — the durable replacement for Claude /loop. Each fire re-wakes that warm session after its prior turn settles; context carries across iterations. Observable via loop:status / fleet:assignments and stoppable with loop:end.",
                "inputSchema": {
                  "type": "object",
                  "properties": {
                    "ownerId": {
                      "description": "Arm the loop for this owner id instead of the caller's own resolved identity (default: yourself). Mirrors loop:end/loop:status's ownerId — the same \"or another owner's\" override, previously missing here (WI-1471).",
                      "type": "string",
                      "maxLength": 120
                    },
                    "intervalSec": {
                      "description": "Seconds AFTER each turn settles before the next wake (≥60). IN AUTO MODE the DEFAULT is 60 (a 1-minute cadence) unless the owner specifies otherwise — only lengthen it when the loop is genuinely blocked on a slower-moving dependency (a deploy, a long gate suite), and restore 1m the moment it clears, because a multi-minute loop is indistinguishable from a dead one to an owner watching for progress. The true period is interval + up-to-30s (the turn-settle is observed on the 30s reconcile tick), so sub-minute is not supported. OMITTED on a retune of an ACTIVE loop: the live interval is inherited, so `loop:arm { carry }` retunes without re-stating it. Required when arming a loop with no active prior.",
                      "type": "integer",
                      "minimum": 60,
                      "maximum": 604800
                    },
                    "blockedOn": {
                      "description": "A bare string is accepted as the `reason`. Pass this WHENEVER you are lengthening the interval because you are BLOCKED (rather than because the work is genuinely slow-moving) — EI-19395290807657827. It records WHY the interval was widened so the premise is re-checked on the next wake instead of silently inherited, caps a blocker-motivated interval whose clearing event is not proven reachable, and lets a fleet leader see \"N members backed off for X, which cleared M minutes ago\".",
                      "type": "object",
                      "properties": {
                        "reason": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 500,
                          "description": "What you are blocked on, in one line (e.g. \"green gate red 8h, blocking every deploy\")."
                        },
                        "event": {
                          "description": "The events:catalog key that fires when this blocker CLEARS. The key is checked against event authority at arm time: only a proven reachable key bypasses the 15min cap; unknown or impossible keys remain capped with evidence in the result. Naming it does not register the await — actually park on it with events:await { event, timeout_sec, on_timeout:'wake' }. If the active monitor loop already uses the same normalized predicate, events:await refuses the duplicate; keep the monitor loop or end it before registering the exact await. Omit this key and the interval is CAPPED to 15min.",
                          "type": "string",
                          "maxLength": 200
                        },
                        "kind": {
                          "description": "What KIND of thing you are blocked on — same vocabulary as coord's blockedOn. With kind:'agent' + `ref`, every wake re-checks that agent's sessionState and tells you when it has DIED, so you stop waiting on a corpse.",
                          "type": "string",
                          "enum": [
                            "process",
                            "event",
                            "work-item",
                            "agent",
                            "owner",
                            "other"
                          ]
                        },
                        "ref": {
                          "description": "The blocker's identity in its own namespace: an ownerId for kind:'agent', a WI-/EI- id for 'work-item', an events:catalog key for 'event'.",
                          "type": "string",
                          "maxLength": 200
                        }
                      },
                      "required": [
                        "reason"
                      ],
                      "additionalProperties": false
                    },
                    "goal": {
                      "description": "One line: what this loop is working toward — echoed into every wake. Auto-truncated to 4000 chars if longer. OMITTED on a retune of an ACTIVE loop: the live goal is inherited, so a carry-only retune does not re-state it. Required when arming a loop with no active prior.",
                      "type": "string",
                      "minLength": 1
                    },
                    "harness": {
                      "description": "Harness the loop is scoped to / namespaced under. Omit it (or use the workspace-global all/* scope) to resolve the workspace home pot; otherwise defaults to your concrete session harness.",
                      "type": "string",
                      "maxLength": 120
                    },
                    "wakePrompt": {
                      "description": "Advanced: a custom per-wake instruction, replacing the default \"create + self-assign your work_items, work them, set_state\" template. Most loops should omit this. Auto-truncated to 4000 chars if longer.",
                      "type": "string"
                    },
                    "workItem": {
                      "description": "The WI-/EI-/F- work-item this WORK loop is driving. For mode:'monitor', pass workItem only when monitor.authority is kind:'work-item' and names this same already-held item. For monitor.authority kind:'fleet-leader' or 'owner-turn', OMIT workItem even if you hold one separately; the fleet/turn authority already governs the monitor. On an active-loop retune, explicit null clears the prior binding while omission preserves it. A work loop attempts to auto-CLAIM a provided item for the loop owner at arm time (WI-2429), subject to fleet-scope admission. When admitted, the item is HELD from wake 1 and a successor/reclaimer inherits it if the session dies. A conflict never steals a live peer's item. If omitted on a COLD work loop, a single WI-/EI-/F- id mentioned in goal is auto-detected and attempted the same way.",
                      "anyOf": [
                        {
                          "type": "string",
                          "maxLength": 120
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "carry": {
                      "description": "Loop lifecycle (su-cold-auto-mode-2026-07-03). DEFAULT: 'warm' for every fresh arm, including headless/fleet sessions; choose 'cold' explicitly when you want fresh-context wakes. A re-arm that omits carry preserves an active prior loop's already-chosen carry. 'warm' = each fire re-wakes THIS same session in place, context carried (an unbounded warm loop can hit the ceiling and die — WI-5557). 'cold' = the fresh-context lifecycle for an UNATTENDED AUTO loop: each fire RESETs the session to its carry-note (a periodic RECYCLE every Nth wake) instead of a warm turn, so the transcript never grows unbounded. Cold requires a carry-note anchor and the cold-auto master gate (decideColdWake). NEVER use 'cold' for an interactive/human-present session (D-005).",
                      "type": "string",
                      "enum": [
                        "warm",
                        "cold"
                      ]
                    },
                    "continuation": {
                      "description": "Continuation policy (flush-to-proceed-stretch-discipline-2026-07-04 P-005). 'settle' (DEFAULT) = today's behaviour — do one iteration's work each wake, then end the turn. 'gated' = the runtime expects MULTIPLE units per turn, each gated by the continuation gate (loop:checkpoint returns the verdict: context headroom below the ceiling? no pending owner input / inbox interrupt?): after settling a unit you flush your checkpoints then continue in-turn while the gate is OPEN, else end the turn. Recovers the per-wake orient/re-read boundary tax by running units back-to-back — arm a LONGER interval for a gated loop. Rides payload_template (no schema change); a settle loop is byte-identical to today.",
                      "type": "string",
                      "enum": [
                        "settle",
                        "gated"
                      ]
                    },
                    "mode": {
                      "description": "Wake-contract shape. 'work' (DEFAULT) = each wake creates + self-assigns work_items and works them. 'monitor' = a leader/supervisor loop that WATCHES something (a fleet, a pipeline, a soak): the wake says check → act only on deltas → checkpoint → end turn, with NO per-wake work-item boilerplate. Ignored when a custom wakePrompt is passed.",
                      "type": "string",
                      "enum": [
                        "work",
                        "monitor"
                      ]
                    },
                    "monitor": {
                      "description": "REQUIRED when mode:'monitor' and refused for work loops. Names the normalized watched predicate, concrete stop condition, finite consecutive no-delta budget (default 1, max 100), and exactly one verified authority: an already-held nonterminal work-item, live durable fleet leadership, or an exact owner-turn ref + quote. With fleet-leader or owner-turn authority, omit the separate top-level workItem argument. Admission is read-only and completes before any work-item claim or routine materialization.",
                      "type": "object",
                      "properties": {
                        "predicateKey": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 200,
                          "description": "Canonical identity of the watched condition. Whitespace/case are normalized at admission."
                        },
                        "stopCondition": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 1000,
                          "description": "Concrete condition that ends this monitor."
                        },
                        "noDeltaBudget": {
                          "default": 1,
                          "description": "Consecutive quiet wakes allowed before automatic standdown (default 1, max 100).",
                          "type": "integer",
                          "minimum": 1,
                          "maximum": 100
                        },
                        "authority": {
                          "oneOf": [
                            {
                              "type": "object",
                              "properties": {
                                "kind": {
                                  "type": "string",
                                  "const": "work-item"
                                },
                                "workItem": {
                                  "type": "string",
                                  "minLength": 3,
                                  "maxLength": 120,
                                  "description": "Existing nonterminal WI-/EI-/F- item already held by the loop owner."
                                }
                              },
                              "required": [
                                "kind",
                                "workItem"
                              ],
                              "additionalProperties": false
                            },
                            {
                              "type": "object",
                              "properties": {
                                "kind": {
                                  "type": "string",
                                  "const": "fleet-leader"
                                },
                                "fleet": {
                                  "type": "string",
                                  "minLength": 1,
                                  "maxLength": 120,
                                  "description": "Durable agent_fleets slug whose registered, live leader is the loop owner."
                                }
                              },
                              "required": [
                                "kind",
                                "fleet"
                              ],
                              "additionalProperties": false
                            },
                            {
                              "type": "object",
                              "properties": {
                                "kind": {
                                  "type": "string",
                                  "const": "owner-turn"
                                },
                                "turnRef": {
                                  "type": "string",
                                  "minLength": 10,
                                  "maxLength": 300,
                                  "description": "Canonical session_turn:<source-kind>:<full-session-id>:<turn-index> reference from this owner session."
                                },
                                "quote": {
                                  "type": "string",
                                  "minLength": 3,
                                  "maxLength": 1000,
                                  "description": "Exact owner text authorizing this monitor; it must occur in the referenced turn."
                                }
                              },
                              "required": [
                                "kind",
                                "turnRef",
                                "quote"
                              ],
                              "additionalProperties": false
                            }
                          ]
                        }
                      },
                      "required": [
                        "predicateKey",
                        "stopCondition",
                        "noDeltaBudget",
                        "authority"
                      ],
                      "additionalProperties": false
                    },
                    "costCapCents": {
                      "description": "Auto-pause the loop if its cumulative cost crosses this many cents (best-effort).",
                      "type": "integer",
                      "exclusiveMinimum": 0,
                      "maximum": 9007199254740991
                    },
                    "maxFires": {
                      "description": "Dead-man guard: auto-pause the loop after this many wake fires SINCE THIS ARM (a bound on a runaway loop). Arm-relative, like maxDurationSec — a re-arm resets the count to 0, so `maxFires: 4` always means \"4 more fires from now\", never a lifetime total (EI-19339729634604096: this used to compare against the loop's cumulative lifetime fire count, so re-arming a session that had already fired more times than the new bound auto-paused it on the very first post-re-arm fire).",
                      "type": "integer",
                      "exclusiveMinimum": 0,
                      "maximum": 9007199254740991
                    },
                    "maxDurationSec": {
                      "description": "Dead-man guard: auto-pause the loop this many seconds after it was armed (a bound on a forgotten / permanently-dead loop). Must be a positive integer. OMIT this optional field when no duration ceiling is intended; `maxDurationSec: 0` is invalid and is not a disable sentinel.",
                      "type": "integer",
                      "exclusiveMinimum": 0,
                      "maximum": 9007199254740991
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
                "name": "loop:checkpoint",
                "description": "COLD carry-note only: writing it does NOT request a carry-respawn; call session:request-compaction separately. Read {read:true,ownerId?,harness?}; write {did,left,insight,next}, {note} or {checkpoint}; clips are reported. carry mode belongs to loop:arm; loop:checkpoint does not accept a `carry` argument. rowsMode:'merge' (default) preserves; rowsMode:'replace' retires; empty list with replace clears. confirmShrink is work_items:checkpoint-only.",
                "inputSchema": {
                  "type": "object",
                  "properties": {
                    "read": {
                      "description": "Read the current carry-note and metadata without writing; use with ownerId?/harness? only.",
                      "type": "boolean"
                    },
                    "note": {
                      "description": "Raw carry-note text; blank/null ⇒ clear. Ignored when any of did/left/insight/next is set.",
                      "anyOf": [
                        {
                          "$ref": "#/$defs/3"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "checkpoint": {
                      "description": "Compatibility alias: a string aliases `note`, an object aliases { did, left, insight, next }. Prefer the canonical form. Blank/null ⇒ clear; `note` and top-level fields win.",
                      "anyOf": [
                        {
                          "anyOf": [
                            {
                              "$ref": "#/$defs/3"
                            },
                            {
                              "type": "object",
                              "properties": {
                                "did": {
                                  "$ref": "#/$defs/3"
                                },
                                "left": {
                                  "$ref": "#/$defs/3"
                                },
                                "insight": {
                                  "$ref": "#/$defs/3"
                                },
                                "next": {
                                  "$ref": "#/$defs/3"
                                },
                                "goal": {
                                  "$ref": "#/$defs/3"
                                },
                                "keyInsight": {
                                  "$ref": "#/$defs/3"
                                },
                                "nextAction": {
                                  "$ref": "#/$defs/3"
                                }
                              },
                              "additionalProperties": false
                            }
                          ]
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "did": {
                      "description": "What this wake accomplished (concrete progress). Input is accepted up to 32000 characters, but persisted text is capped at 8000; any clipped text is listed in the response's repairs.",
                      "anyOf": [
                        {
                          "$ref": "#/$defs/3"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "left": {
                      "description": "What remains, in order.",
                      "anyOf": [
                        {
                          "$ref": "#/$defs/3"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "insight": {
                      "description": "The non-obvious thing a cold successor would waste time re-deriving. Its FIRST LINE is harvested verbatim as an observation title, so lead that line with the stable subject (tool/verb name, surface, file path, error class) and keep the story on the lines below.",
                      "anyOf": [
                        {
                          "$ref": "#/$defs/3"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "next": {
                      "description": "The single concrete next action for the next wake.",
                      "anyOf": [
                        {
                          "$ref": "#/$defs/3"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "keyInsight": {
                      "description": "Compatibility alias for `insight`; explicit `insight` wins when both are supplied.",
                      "anyOf": [
                        {
                          "$ref": "#/$defs/3"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "nextAction": {
                      "description": "Compatibility alias for `next`; explicit `next` wins when both are supplied.",
                      "anyOf": [
                        {
                          "$ref": "#/$defs/3"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "goal": {
                      "description": "Compatibility alias for `next`, for callers mirroring loop:arm { goal }. Explicit `next` wins when both are supplied.",
                      "anyOf": [
                        {
                          "$ref": "#/$defs/3"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "workItem": {
                      "description": "Compatibility metadata for an associated work-item id; accepted but does not change loop scope (ownerId remains authoritative). Also the anchor `learned` writes from. Explicit null is treated as omission.",
                      "anyOf": [
                        {
                          "type": "string",
                          "maxLength": 120
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "learned": {
                      "description": "a durable lesson to post on the effort thread in this same call — the part of this private loop note a future agent needs. Requires `workItem` as the anchor; use learnedLevel to attach it at that item's plan or goal instead.",
                      "anyOf": [
                        {
                          "type": "string",
                          "maxLength": 4000
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "learnedLevel": {
                      "description": "which level `learned` belongs to — write at the level you are working at. Default 'work_item'; a level the anchor item lacks falls back to the most specific one it has.",
                      "type": "string",
                      "enum": [
                        "work_item",
                        "plan",
                        "goal"
                      ]
                    },
                    "walls": {
                      "description": "Open WALLS (owner-gated commitments) as rows — rendered into EVERY wake + carry brief until cleared. Compact claim strings are accepted (`walls: ['owner approval']`) and mapped losslessly to `{ claim }`; a JSON-encoded array is accepted for stale wire manifests. OMITTED ⇒ existing walls CARRY FORWARD (a rewrite or note-clear never drops them); a supplied list REPLACES (the default is rowsMode:'merge', which upserts instead), so pass the full current set (dropped ones come back as `wallsDropped`) only when retiring rows; [] clears under replace.",
                      "maxItems": 48,
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "claim": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 2000,
                            "x-soft-maxLength": 500,
                            "description": "The pending owner-gated action/decision, stated concretely. Soft cap: 500 chars; longer values are accepted and truncated with a reported repair. Hard input backstop: 2000 chars; larger values are rejected."
                          },
                          "id": {
                            "$ref": "#/$defs/0"
                          },
                          "replaces": {
                            "$ref": "#/$defs/4"
                          },
                          "recheck": {
                            "type": "string",
                            "maxLength": 1200,
                            "x-soft-maxLength": 300,
                            "description": "A concrete command a successor runs to re-check it. Soft cap: 300 chars; longer values are accepted and truncated with a reported repair. Hard input backstop: 1200 chars; larger values are rejected."
                          },
                          "description": {
                            "$ref": "#/$defs/2"
                          },
                          "key": {
                            "$ref": "#/$defs/0"
                          }
                        },
                        "required": [
                          "claim"
                        ],
                        "additionalProperties": false
                      }
                    },
                    "checks": {
                      "description": "Durable storage is capped at 12 check rows. This input accepts up to 48 rows as a hard validation/normalization ceiling; an accepted array size is not a persistence promise. Carried CHECKS are claims about EXTERNAL STATE as {claim, recheck, verified?, contested?} rows (compact claim strings are accepted and mapped to {claim}; the non-owner analog of walls; renders a ## Checks section every wake). `verified` is a STRING (evidence, ≤300 chars), never a boolean — a claim OMITTING `verified` renders PREDICTED, a successor must run its recheck before relying on it. There is no caller-supplied `sinceMs` field here: that timestamp is server-owned carry metadata, inherited for existing claims and stamped for new claims. Do not copy `sinceMs` from work_items:checkpoint rows. If its evidence contains STILL RUNNING, pending, outstanding, in-flight, unverified, or awaiting while the claim asserts a completed/healthy state, the writer downgrades it to `contested` and reports the repair; when the claim itself asserts that unresolved state, the evidence remains VERIFIED. Use `contested` to force an explicit warning; contested rows render ⚠ and require a re-check. Put hash/id/timestamp expectations HERE, never in Left prose. Same carry-forward semantics as walls: omitted rows and [] preserve the carried set under either rowsMode. Retire individual rows with retireIds; confirmRetire never authorizes omission or cap eviction. An overflow refuses the row write and saves the narrative with prior rows intact, including legacy over-cap rows.",
                      "maxItems": 48,
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "claim": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 2000,
                            "x-soft-maxLength": 500,
                            "description": "The external-state claim, stated concretely. Soft cap: 500 chars; longer values are accepted and truncated with a reported repair. Hard input backstop: 2000 chars; larger values are rejected."
                          },
                          "id": {
                            "$ref": "#/$defs/0"
                          },
                          "replaces": {
                            "$ref": "#/$defs/4"
                          },
                          "recheck": {
                            "type": "string",
                            "maxLength": 1200,
                            "x-soft-maxLength": 300,
                            "description": "Concrete probe to run before relying on the claim. Soft cap: 300 chars; longer values are accepted and truncated with a reported repair. Hard input backstop: 1200 chars; larger values are rejected."
                          },
                          "falsifier": {
                            "type": "string",
                            "maxLength": 1200,
                            "x-soft-maxLength": 300,
                            "description": "Result that would mean this claim is FALSE (as facts:assert `falsifier`). A probe says how to look; this says what refutes it. Soft cap: 300 chars; longer values are accepted and truncated with a reported repair. Hard input backstop: 1200 chars; larger values are rejected."
                          },
                          "sampleAdequate": {
                            "description": "`false` = probed, but the sample could not discriminate the claim from its negation; renders ? not ✓.",
                            "type": "boolean"
                          },
                          "verified": {
                            "type": "string",
                            "maxLength": 1200,
                            "x-soft-maxLength": 300,
                            "description": "The EVIDENCE STRING itself (max 300 chars) — e.g. \"Verified 15:14Z: 30/30 passed, tree clean\". NOT a boolean (`true`/`false` is rejected) and NOT `{status, evidence}` — this ONE string field carries both the verified/PREDICTED flag and its justification: presence of `verified` (however short) renders the row VERIFIED; omitting it entirely renders PREDICTED. There is no separate boolean flag to set. Soft cap: 300 chars; longer values are accepted and truncated with a reported repair. Hard input backstop: 1200 chars; larger values are rejected."
                          },
                          "observed": {
                            "type": "string",
                            "maxLength": 1200,
                            "x-soft-maxLength": 300,
                            "description": "Observed context that does not affirm the claim. It renders on a ? PREDICTED row so the context survives without acquiring verification authority. Soft cap: 300 chars; longer values are accepted and truncated with a reported repair. Hard input backstop: 1200 chars; larger values are rejected."
                          },
                          "ok": {
                            "description": "Compatibility alias for boolean check results: `{ ok: true|false }` is normalized to the `verified` evidence slot before storage. A bare true or false remains PREDICTED; pair true with `evidence` to render VERIFIED. Prefer the canonical `verified` evidence string.",
                            "type": "boolean"
                          },
                          "contested": {
                            "type": "string",
                            "maxLength": 1200,
                            "x-soft-maxLength": 300,
                            "description": "Evidence that was supplied as verification but contradicts the claim (for example, a green claim with \"STILL RUNNING\"). Rendered with ⚠ CONTESTED and never upgraded to VERIFIED; re-check before relying on the claim. Soft cap: 300 chars; longer values are accepted and truncated with a reported repair. Hard input backstop: 1200 chars; larger values are rejected."
                          },
                          "probe": {
                            "description": "Optional schema-versioned, read-only executable probe. `{kind:'tool',tool,args?,schemaRevision,expect}` or `{kind:'state-cell',cell,as,schemaRevision,expect}`. Required: kind, target, schemaRevision, expect; args defaults to `{}`. `probe:{ expect:... }` has no target; omit `probe` and use `recheck` for a human command. Validated against the live tool/cell contract before any checkpoint bytes persist; `recheck` remains the human explanation.",
                            "oneOf": [
                              {
                                "type": "object",
                                "properties": {
                                  "kind": {
                                    "type": "string",
                                    "const": "tool"
                                  },
                                  "tool": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 200,
                                    "description": "Exact direct projected-tool name. Only directly invoked read-only tools may be persisted; indirect/meta surfaces such as `dev:pg_query`, `tools:invoke`, `code:run`, `recipes:run`, `capability:*`, and `computer:*` are rejected."
                                  },
                                  "args": {
                                    "default": {},
                                    "type": "object",
                                    "propertyNames": {
                                      "type": "string"
                                    },
                                    "additionalProperties": {}
                                  },
                                  "projection": {
                                    "type": "object",
                                    "additionalProperties": true,
                                    "description": "matches any object value"
                                  },
                                  "schemaRevision": {
                                    "$ref": "#/$defs/1"
                                  },
                                  "expect": {
                                    "$ref": "#/$defs/5"
                                  }
                                },
                                "required": [
                                  "kind",
                                  "tool",
                                  "args",
                                  "schemaRevision",
                                  "expect"
                                ],
                                "additionalProperties": false
                              },
                              {
                                "type": "object",
                                "properties": {
                                  "kind": {
                                    "type": "string",
                                    "const": "state-cell"
                                  },
                                  "cell": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 120
                                  },
                                  "as": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 200
                                  },
                                  "schemaRevision": {
                                    "$ref": "#/$defs/1"
                                  },
                                  "expect": {
                                    "$ref": "#/$defs/5"
                                  }
                                },
                                "required": [
                                  "kind",
                                  "cell",
                                  "schemaRevision",
                                  "expect"
                                ],
                                "additionalProperties": false
                              },
                              {
                                "type": "object",
                                "properties": {
                                  "kind": {
                                    "type": "string",
                                    "const": "sql"
                                  },
                                  "sql": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 4000,
                                    "description": "One read-only SELECT or WITH…SELECT, run through dev:pg_query: READ ONLY transaction, row cap and statement timeout are always applied, and a write is refused without changing any row. `expect` reads the dev:pg_query result, e.g. { path: \"$.rows[0].n\", op: \"gte\", value: 1 }."
                                  },
                                  "maxRows": {
                                    "default": 50,
                                    "description": "Row cap passed to dev:pg_query (default 50).",
                                    "type": "integer",
                                    "exclusiveMinimum": 0,
                                    "maximum": 2000
                                  },
                                  "allowUnscoped": {
                                    "description": "Forwarded to dev:pg_query: allow a deliberate cross-tenant read of a tenant-scoped table.",
                                    "type": "boolean"
                                  },
                                  "schemaRevision": {
                                    "$ref": "#/$defs/1"
                                  },
                                  "expect": {
                                    "$ref": "#/$defs/5"
                                  }
                                },
                                "required": [
                                  "kind",
                                  "sql",
                                  "maxRows",
                                  "schemaRevision",
                                  "expect"
                                ],
                                "additionalProperties": false
                              }
                            ]
                          },
                          "kind": {
                            "type": "string",
                            "maxLength": 2000,
                            "x-soft-maxLength": 500,
                            "description": "Compatibility alias for `claim` in structured verification rows; prefer `claim`. Soft cap: 500 chars; longer values are accepted and truncated with a reported repair. Hard input backstop: 2000 chars; larger values are rejected."
                          },
                          "command": {
                            "type": "string",
                            "maxLength": 1200,
                            "x-soft-maxLength": 300,
                            "description": "Compatibility alias for `recheck` in structured verification rows; prefer `recheck`. Soft cap: 300 chars; longer values are accepted and truncated with a reported repair. Hard input backstop: 1200 chars; larger values are rejected."
                          },
                          "description": {
                            "$ref": "#/$defs/2"
                          },
                          "result": {
                            "type": "string",
                            "maxLength": 1200,
                            "x-soft-maxLength": 300,
                            "description": "Compatibility alias for `verified` in structured verification rows; prefer `verified`. Soft cap: 300 chars; longer values are accepted and truncated with a reported repair. Hard input backstop: 1200 chars; larger values are rejected."
                          },
                          "testResult": {
                            "type": "string",
                            "maxLength": 1200,
                            "x-soft-maxLength": 300,
                            "description": "Compatibility alias for completion-style `testResult`; normalized to the canonical `verified` evidence string before storage. Prefer `verified`. Soft cap: 300 chars; longer values are accepted and truncated with a reported repair. Hard input backstop: 1200 chars; larger values are rejected."
                          },
                          "tool": {
                            "description": "Compatibility field for a flattened tool probe.",
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 200
                          },
                          "args": {
                            "description": "Compatibility field for flattened tool-probe arguments.",
                            "type": "object",
                            "propertyNames": {
                              "type": "string"
                            },
                            "additionalProperties": {}
                          },
                          "projection": {
                            "type": "object",
                            "additionalProperties": true,
                            "description": "Compatibility field for a flattened tool-probe projection."
                          },
                          "schemaRevision": {
                            "description": "Compatibility field for a flattened probe revision.",
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 160
                          },
                          "expect": {
                            "description": "Compatibility field for a flattened probe predicate.",
                            "$ref": "#/$defs/continuity-predicate-v1"
                          },
                          "cell": {
                            "description": "Compatibility field for a flattened state-cell probe.",
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 120
                          },
                          "as": {
                            "description": "Compatibility field for a flattened state-cell reader.",
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 200
                          }
                        },
                        "required": [
                          "claim"
                        ],
                        "additionalProperties": false
                      }
                    },
                    "dependsOn": {
                      "description": "P-007 freshness: what this carry-note is derived FROM, as `kind:ref` tags — supported kinds: file, work-item, plan (e.g. \"file:packages/operator-core/lib/x.ts\", \"work-item:WI-6198\", \"plan:my-plan-slug\"). Each is resolved to a version token and stamped NOW, so a later reader is told WHICH dependency moved instead of guessing from the carry-note's age. Declaring them makes an OLD carry-note readable as fresh when nothing moved, and — the case no age threshold can catch — a SECONDS-OLD one as stale when a PEER changed a file it depends on. Omit to keep the previous declaration; pass [] to clear it.",
                      "maxItems": 24,
                      "type": "array",
                      "items": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 300
                      }
                    },
                    "rowsMode": {
                      "description": "Durable caps are 12 walls and 12 checks. The arrays may accept up to 48 rows each for validation/normalization; accepted input size is not a persistence promise. How a supplied walls/checks list combines with the carried set. 'merge' (default) — rows UPSERT by `id` (else by exact claim text) and unmentioned rows SURVIVE, so adding/updating ONE row needs only that row. 'replace' also preserves omitted rows: retirement always requires `retireIds`. At the cap, an overflowing row write is refused while its narrative is saved with carried rows intact. To edit ONE row use its stable id or `replaces`; to close it use `retireIds`. An empty list is a no-op.",
                      "type": "string",
                      "enum": [
                        "replace",
                        "merge"
                      ]
                    },
                    "retireIds": {
                      "description": "Retire carried walls/checks by stable [#id] in this same write, under either rowsMode — no full resend. Reported as `wallsRetired`/`checksRetired`; unmatched refs as `unmatchedRowRefs`.",
                      "maxItems": 96,
                      "type": "array",
                      "items": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 2000
                      }
                    },
                    "confirmRetire": {
                      "description": "Compatibility field. Does not authorize dropping omitted rows or cap eviction; name each closed row in `retireIds`.",
                      "type": "boolean"
                    },
                    "expectedHash": {
                      "description": "Optional optimistic-CAS baseline: the 12-character contentHash returned by the last loop:checkpoint/read. Use null to assert that no note existed; on mismatch the write is refused and the current hash is returned.",
                      "anyOf": [
                        {
                          "type": "string",
                          "pattern": "^[0-9a-f]{12}$"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "monitorDelta": {
                      "description": "MONITOR loops only (loop:arm { mode:\"monitor\" }): did this wake observe a real DELTA in the watched predicate? true RESETS the consecutive no-delta budget; omitted or false counts as a QUIET wake and decrements it, so a monitor whose budget runs out is stood down by the engine even if you never call loop:end. Ignored on a work loop.",
                      "type": "boolean"
                    },
                    "ownerId": {
                      "description": "The loop owner id (default: your own resolved identity). Mirrors loop:arm/end/status.",
                      "type": "string",
                      "maxLength": 120
                    },
                    "harness": {
                      "description": "Harness the loop is scoped under (default: your session harness / home pot). Honoured on a READ — the way to reach a note stranded in another scope. On a WRITE an armed loop routine outranks it, so the note lands where the next cold wake reads; the reply then reports `explicitHarnessIgnored`.",
                      "type": "string",
                      "maxLength": 120
                    }
                  },
                  "additionalProperties": false,
                  "$defs": {
                    "0": {
                      "description": "Stable id for this row (e.g. 'gate-green'), independent of wording. Lets you RE-WORD the claim without losing its evidence/age, and is what rowsMode:'merge' upserts on. Soft cap: 40 chars; longer inputs are accepted and truncated with a reported repair. Hard input backstop: 160 chars; larger inputs are rejected. Omitted ⇒ identity is the claim text.",
                      "type": "string",
                      "maxLength": 160,
                      "x-soft-maxLength": 40
                    },
                    "1": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 160,
                      "description": "Exact projected-tool-registry revision for this target. Writer-only `live` is expanded to the current target revision before validation; persisted and replayed probes contain the concrete revision."
                    },
                    "2": {
                      "type": "string",
                      "maxLength": 2000,
                      "x-soft-maxLength": 500,
                      "description": "Compatibility alias for `claim`; prefer `claim`. Soft cap: 500 chars; longer values are accepted and truncated with a reported repair. Hard input backstop: 2000 chars; larger values are rejected."
                    },
                    "3": {
                      "type": "string",
                      "maxLength": 32000
                    },
                    "4": {
                      "description": "Edit a carried row in place: its [#id] or exact claim. Keeps its evidence/age; the row gains a stable id. Unmatched refs are reported.",
                      "type": "string",
                      "maxLength": 4000
                    },
                    "5": {
                      "$ref": "#/$defs/continuity-predicate-v1"
                    },
                    "continuity-predicate-v1": {
                      "type": "object",
                      "properties": {
                        "path": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 240,
                          "description": "Dot/bracket path into the JSON result; use \"$\" for the root value."
                        },
                        "op": {
                          "type": "string",
                          "enum": [
                            "exists",
                            "eq",
                            "ne",
                            "gt",
                            "gte",
                            "lt",
                            "lte"
                          ],
                          "description": "Predicate operation. `exists` checks presence and MUST omit `value`; comparison operations require a scalar `value`."
                        },
                        "value": {
                          "description": "Expected scalar for comparison operations; omit this field when `op` is `exists`.",
                          "anyOf": [
                            {
                              "type": "string",
                              "maxLength": 1000
                            },
                            {
                              "type": "number"
                            },
                            {
                              "type": "boolean"
                            },
                            {
                              "type": "null"
                            }
                          ]
                        }
                      },
                      "required": [
                        "path",
                        "op"
                      ],
                      "additionalProperties": false
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
                "name": "loop:end",
                "description": "End the owner-scoped loop on your own session (or another owner's, with `ownerId`) — stops the recurring warm wake. The routine is deactivated (history kept); an optional `reason` is recorded in the transition log. A GOAL-mode owner with a still-active goal must also pass `disposition` (achieved | killed | handoff) — the wind-down report to the owner is generated from the loop carry-note + reason. Loops are keyed by owner, not by harness; a `harness` arg is accepted for compatibility but has no effect. Re-arm anytime with loop:arm.",
                "inputSchema": {
                  "type": "object",
                  "properties": {
                    "harness": {
                      "description": "Accepted for compatibility and IGNORED — loops are keyed by owner, not by harness, so this has no effect. Present only because nearly every other tool in this catalog takes a `harness` arg and callers reasonably reach for it out of habit; omit it, or pass anything.",
                      "type": "string",
                      "maxLength": 120
                    },
                    "ownerId": {
                      "description": "End the loop for this owner id (default: yourself).",
                      "type": "string",
                      "maxLength": 120
                    },
                    "reason": {
                      "description": "Optional durable reason for ending the loop; recorded in the loop transition log.",
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 500
                    },
                    "disposition": {
                      "description": "GOAL-mode wind-down verdict, REQUIRED when the target owner's goal is still active: 'achieved' | 'killed' | 'handoff'. Recorded on the goal; the owner report is auto-generated from the loop carry-note + `reason`.",
                      "type": "string",
                      "enum": [
                        "achieved",
                        "killed",
                        "handoff"
                      ]
                    },
                    "handoffTo": {
                      "description": "With disposition:'handoff' — who continues the goal (owner id / label). The goal stays active.",
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 120
                    },
                    "outputs": {
                      "description": "P-021: the goal's reported outputs, validated against its declared output_schema. With disposition:'achieved' every declared-required output must be filled (refused otherwise); 'killed' accepts partial/absent; 'handoff' records nothing.",
                      "type": "object",
                      "propertyNames": {
                        "type": "string"
                      },
                      "additionalProperties": {}
                    },
                    "acknowledgeOpenDirectives": {
                      "description": "EI-11484 guard: open owner directives soft-block loop:end (ending removes their wake render surface). Pass true to consciously proceed with them still open.",
                      "type": "boolean"
                    },
                    "acknowledgeWakeLessAutonomy": {
                      "description": "P-012 safety override: consciously end the loop while an autonomy-implying mode remains active and no deliberate independent event await will wake the session. Does NOT override the P-009 claim-holder refusal.",
                      "type": "boolean"
                    },
                    "ownerStopDirectiveId": {
                      "description": "P-009: the id of the hook-captured owner directive (orders:get) that told THIS session to stop. Lets an autonomous session that still holds work-items end its loop without a bounded wake; verified, never trusted.",
                      "type": "integer",
                      "exclusiveMinimum": 0,
                      "maximum": 9007199254740991
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
                "name": "loop:status",
                "description": "Inspect the loop on your own session (or another owner's, with `ownerId`); this read is owner-scoped, so a `harness` arg is accepted and ignored. It reports active?, interval, parked (turn in flight), next/last fire, cost-cap, latest lifecycle transition, and the current carry-note read-back. Four fields carry warnings you must read before acting — `turnsStalled` (armed but not producing), `cadenceDrift` (a late fire path after sustained slow cadence), `pendingAwaits` (whether you are REALLY parked), and a `storeIdentityViolation` guard that makes a `null` mean UNKNOWN rather than \"no loop\": see `returns`.",
                "inputSchema": {
                  "type": "object",
                  "properties": {
                    "harness": {
                      "description": "Accepted for compatibility and IGNORED — loops are keyed by owner, not by harness, so this has no effect. Present only because nearly every other tool in this catalog takes a `harness` arg and callers reasonably reach for it out of habit; omit it, or pass anything.",
                      "type": "string",
                      "maxLength": 120
                    },
                    "ownerId": {
                      "description": "Inspect the loop for this owner id, or 'self' for the caller (default: yourself). Mirrors loop:arm/end/checkpoint. `owner` is also accepted (folded into ownerId before parse; ownerId wins).",
                      "type": "string",
                      "maxLength": 120
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
                "name": "dev:pg_query",
                "description": "Bounded read-only SQL/EXPLAIN or relation description in operator Postgres. Tenant reads need scope unless `allowUnscoped`; pass `positiveControlSql` for zero-row absence claims. PostgreSQL regex repetition is limited to 255. Rubrics use `harness_shared.harness_plans` (`template = 'rubric'`); `harness_shared.rubrics` is retired.",
                "inputSchema": {
                  "type": "object",
                  "anyOf": [
                    {
                      "type": "object",
                      "properties": {
                        "sql": {
                          "type": "string",
                          "minLength": 1,
                          "description": "A single read-only SELECT, WITH…SELECT, or EXPLAIN whose explained statement is SELECT/WITH…SELECT. No `;`-separated statements. Serialized SQL results are capped at 4 MiB; select fewer columns/rows or aggregate large JSON values."
                        },
                        "describe": {
                          "description": "Only valid for relation-description calls; omit it when passing `sql`.",
                          "not": {}
                        },
                        "maxRows": {
                          "$ref": "#/$defs/0"
                        },
                        "timeoutMs": {
                          "description": "Bounds the whole dev:pg_query handler, including tenant preflight, SQL execution, result advisories, and optional error enrichment (default 5000, max 30000), plus a fixed ~3s overhead allowance (so the default wall-clock deadline is ~8000ms). The SQL query receives only the remaining budget after preflight; a later phase that hangs returns call_timeout at the same shared deadline. Size timeoutMs for the work across phases, not only the SQL statement.",
                          "type": "integer",
                          "exclusiveMinimum": 0,
                          "maximum": 30000
                        },
                        "positiveControlSql": {
                          "description": "Known-positive row-returning SELECT/WITH…SELECT expected to return at least one row through the same table/scope/instrument. Runs with the primary query in the same read-only transaction and whole-call deadline. Use when zero rows will support an absence claim; ungrouped scalar COUNT aggregates are rejected because they return a row even when no source rows match.",
                          "type": "string",
                          "minLength": 1
                        },
                        "allowUnscoped": {
                          "default": false,
                          "description": "Explicitly allow a filtered read of a tenant-scoped table without a workspace_id/harness_slug predicate. Use only for deliberate cross-tenant analysis; the response retains the tenant-scope advisory.",
                          "type": "boolean"
                        },
                        "allowUnboundedJsonSearch": {
                          "default": false,
                          "description": "Explicitly allow an unbounded LIKE/ILIKE scan over tool_invocations.args_json/metadata_json cast to text. maxRows does not bound the WHERE scan; prefer indexed scalar predicates or activity:tool-log/dev:telemetry.",
                          "type": "boolean"
                        }
                      },
                      "required": [
                        "sql",
                        "allowUnscoped",
                        "allowUnboundedJsonSearch"
                      ],
                      "additionalProperties": false
                    },
                    {
                      "type": "object",
                      "properties": {
                        "sql": {
                          "description": "Only valid for SQL calls; omit it when passing `describe`.",
                          "not": {}
                        },
                        "describe": {
                          "type": "string",
                          "minLength": 1,
                          "description": "Instead of running SQL, describe a relation: columns, indexes and constraints — the psql `\\d` equivalent. A dotted STRING, not an object: `\"harness_shared.work_items\"` (a bare table name also resolves), or a `*`/glob — `\"harness_shared.*\"` — to LIST matching relations."
                        },
                        "maxRows": {
                          "$ref": "#/$defs/0"
                        },
                        "timeoutMs": {
                          "description": "Bounds the whole dev:pg_query handler, including relation lookup and optional near-match enrichment (default 5000, max 30000), plus a fixed ~3s overhead allowance (so the default wall-clock deadline is ~8000ms). A hung metadata lookup returns call_timeout at the shared handler deadline.",
                          "type": "integer",
                          "exclusiveMinimum": 0,
                          "maximum": 30000
                        },
                        "positiveControlSql": {
                          "description": "Only valid for SQL calls; omit it when passing `describe`.",
                          "not": {}
                        },
                        "allowUnscoped": {
                          "default": false,
                          "description": "Explicitly allow a filtered read of a tenant-scoped table without a workspace_id/harness_slug predicate. Use only for deliberate cross-tenant analysis; the response retains the tenant-scope advisory.",
                          "type": "boolean"
                        },
                        "allowUnboundedJsonSearch": {
                          "description": "Only valid for SQL calls; omit it when passing `describe`.",
                          "not": {}
                        }
                      },
                      "required": [
                        "describe",
                        "allowUnscoped"
                      ],
                      "additionalProperties": false
                    }
                  ],
                  "$defs": {
                    "0": {
                      "description": "Max rows returned (default 200).",
                      "type": "integer",
                      "exclusiveMinimum": 0,
                      "maximum": 2000
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
                  "papercusp/resultFormats": [
                    "json"
                  ],
                  "papercusp/servingGeneration": "serving-generation-v1:a528040778992a8ce2dda4696ff0affe43345629ae38c3e3ff7732a35db2389c"
                }
              },
              {
                "name": "docs:search",
                "description": "Keyword search over the current harness/project docs, or the Papercusp framework for su callers. `query` wins over legacy `q`; returns ranked slug/title/description/excerpt hits. Harness/project scope excludes agent-insights and framework docs, so weak results include `scopeNote`; do not read them as absence. Workspace sessions cannot use `harness:'all'`; use `harness:'engineering'` for that corpus.",
                "inputSchema": {
                  "type": "object",
                  "properties": {
                    "scope": {
                      "description": "Read only the canonical public user manual and FAQ. Never accesses project or engineering docs; cannot combine with harness.",
                      "type": "string",
                      "const": "public"
                    },
                    "query": {
                      "type": "string",
                      "minLength": 2,
                      "maxLength": 200,
                      "description": "Keyword query. Legacy alias: `q`. Whitespace-separated tokens; tokens <2 chars dropped."
                    },
                    "limit": {
                      "default": 8,
                      "description": "Max hits returned. Default 8.",
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 20
                    },
                    "harness": {
                      "description": "Harness slug whose docs to search. Pass 'all' for Papercusp's own framework docs / your project docs (operator scope) — but only on an UNSCOPED (--all-workspaces) session; a workspace-scoped su session gets harness_forbidden for 'all'/'*' (EI-12898). To reach the SAME framework/agent-insights corpus from a workspace-scoped session, pass 'engineering' instead — a distinct literal the workspace clamp does not intercept (EI-18894866320087268). Omit only when the session is already scoped to a harness — otherwise you'll get harness_required.",
                      "type": "string"
                    },
                    "semantic": {
                      "description": "Fuse an embedding-cosine leg with the keyword leg (RRF), so a topically-exact page whose words never appear verbatim still ranks. Hits found ONLY that way are marked semantic:true. Default on (off under vitest); false = lexical-only. Read `legs` on the response for whether it actually ran: legs.degraded=true means the ranking is NOT the one this promises.",
                      "type": "boolean"
                    }
                  },
                  "required": [
                    "query",
                    "limit"
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
                  "papercusp/resultFormats": [
                    "json"
                  ],
                  "papercusp/servingGeneration": "serving-generation-v1:a528040778992a8ce2dda4696ff0affe43345629ae38c3e3ff7732a35db2389c"
                }
              },
              {
                "name": "mode:set",
                "description": "Enter/exit an official session mode (audit | auto | cold-auto | drain | goal | grade | ideate | test) for yourself or a peer. { mode, reason, enabled?, instructions?, agent?, ownerDirected? }. Same-axis modes AUTO-SWITCH (result carries switchedFrom); cross-axis modes stack. Peer-set: reason is delivered to the target with the mode contract. An owner-directed incumbent REFUSES peer overrides. Such an override is downgraded to a request message (stickyConflict:true). Self-set returns the full binding contract — read it. Audited in agent_mode_changes.",
                "inputSchema": {
                  "type": "object",
                  "properties": {
                    "mode": {
                      "type": "string",
                      "enum": [
                        "audit",
                        "auto",
                        "cold-auto",
                        "drain",
                        "goal",
                        "grade",
                        "ideate",
                        "test"
                      ],
                      "description": "the mode id"
                    },
                    "reason": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 2000,
                      "description": "why — MANDATORY; delivered to a peer target verbatim"
                    },
                    "instructions": {
                      "description": "SCOPE INSTRUCTIONS that must survive compaction — e.g. drain \"all bugs except the ones related to the p2p features\". Delivered with the mode change AND asserted as a standing fact on the target (key 'mode-instructions:<mode>'), so it is re-injected VERBATIM on every wake until the mode is turned off, which retracts it. Clipped at 1200 chars. Use `reason` for WHY the mode changed; use this for WHAT the mode is scoped to.",
                      "type": "string",
                      "maxLength": 4000
                    },
                    "subject": {
                      "description": "WHAT this mode is about — required for a subject-requiring mode (goal: the harness_shared.goals.id). Omit to leave an incumbent subject untouched. Prefer goals:start / goals:create, which open the goal AND stamp this atomically; pass it here only when re-registering a mode whose goal already exists.",
                      "type": "string",
                      "maxLength": 200
                    },
                    "enabled": {
                      "description": "default true; false ⇒ exit the mode",
                      "type": "boolean"
                    },
                    "agent": {
                      "description": "target ownerId (exact, e.g. su-…); omit for yourself",
                      "type": "string",
                      "maxLength": 120
                    },
                    "ownerId": {
                      "description": "Compatibility alias for `agent`, for callers carrying the roster/presence field name; normalized to `agent` before use. Pass one or the other — `agent` wins if both are given.",
                      "type": "string",
                      "maxLength": 120
                    },
                    "ownerDirected": {
                      "description": "the human owner explicitly instructed this mode (self-set only) — arms the owner-sticky guard",
                      "type": "boolean"
                    }
                  },
                  "required": [
                    "mode",
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
                  "papercusp/resultFormats": [
                    "json"
                  ],
                  "papercusp/servingGeneration": "serving-generation-v1:a528040778992a8ce2dda4696ff0affe43345629ae38c3e3ff7732a35db2389c"
                }
              },
              {
                "name": "fleet:launch-on-plan",
                "description": "Launch N su members on an existing plan — visible or headless. Ensures fleet, leadership, plan binding and first-turn request; do not assemble them with capability:launch-agent/terminal. Process open is not proof of registration, a verified first turn, or a claimed task; read `launchTransaction`. `carry` picks warm/cold; `placement:'remote'` uses delegated-seat machines.",
                "inputSchema": {
                  "type": "object",
                  "properties": {
                    "name": {
                      "type": "string",
                      "minLength": 1,
                      "description": "Fleet name — created (you become leader) if new, else joined. Slugified to the durable handle."
                    },
                    "plan": {
                      "description": "Plan slug (filename without .md) the members should work — must already exist. OPTIONAL (P-003): omit it to launch a PURE CLAIM-SPEC fleet (members self-pull by `claimKinds`, no plan lane). When omitted, `claimKinds` is REQUIRED so the members have a lane to drain.",
                      "type": "string",
                      "minLength": 1
                    },
                    "harness": {
                      "description": "Harness the plan belongs to. Defaults to the session's harness scope; required when the session is unscoped.",
                      "type": "string"
                    },
                    "directors": {
                      "description": "type:'paired' ONLY (D-009): the DIRECTOR half of every pair — the session that decomposes the plan item into milestones, issues one directive at a time, verifies each from the ledger, and closes the milestone work items. Give it the strongest model you are willing to pay for (D-006): its job is judgement, and it never loads file bodies so it stays cheap per turn. Each knob here is independent of `implementers`. Passing this on a type:'single' fleet is rejected.",
                      "type": "object",
                      "properties": {
                        "agent": {
                          "$ref": "#/$defs/1"
                        },
                        "model": {
                          "type": "string"
                        },
                        "effort": {
                          "type": "string"
                        },
                        "headless": {
                          "type": "boolean"
                        },
                        "account": {
                          "type": "string"
                        },
                        "carry": {
                          "type": "string",
                          "enum": [
                            "warm",
                            "cold"
                          ]
                        },
                        "count": {
                          "$ref": "#/$defs/0"
                        }
                      },
                      "additionalProperties": false
                    },
                    "implementers": {
                      "description": "type:'paired' ONLY (D-009): the IMPLEMENTER half of every pair — the session that edits, tests and reports, and cannot self-direct (it is parked between directives and tool-denied from completing work items or arming loops). May be a CHEAPER tier than the director (D-006), and a different model FAMILY is preferred so the pair's errors decorrelate. Passing this on a type:'single' fleet is rejected.",
                      "type": "object",
                      "properties": {
                        "agent": {
                          "$ref": "#/$defs/1"
                        },
                        "model": {
                          "type": "string"
                        },
                        "effort": {
                          "type": "string"
                        },
                        "headless": {
                          "type": "boolean"
                        },
                        "account": {
                          "type": "string"
                        },
                        "carry": {
                          "type": "string",
                          "enum": [
                            "warm",
                            "cold"
                          ]
                        },
                        "count": {
                          "$ref": "#/$defs/0"
                        }
                      },
                      "additionalProperties": false
                    },
                    "type": {
                      "description": "Fleet TYPE (D-008), which also SELECTS THE OPTION SHAPE this call accepts (D-009). 'single' (default) is today's fleet, unchanged: N independent members configured by the FLAT knobs (agent/model/count/headless/account/carry/…). 'paired' launches N director↔implementer pairs and takes those same knobs as two per-role groups instead — `directors:{…}` and `implementers:{…}` — so a top-tier visible director can sit beside cheaper headless implementers. The shapes do not merge: passing per-role groups with type 'single', or flat per-member knobs with type 'paired', is REJECTED with invalid_args naming the expected shape, never coerced (a flat value broadcast to both roles is how you end up with a fleet of directors running the implementer's model).",
                      "type": "string",
                      "enum": [
                        "single",
                        "paired"
                      ]
                    },
                    "agent": {
                      "description": "Backend each member runs. When omitted, a known model family selects its native backend (`luna`/`terra`/`sol`/`gpt-*` → `codex`; `opus`/`sonnet`/`haiku`/`fable`/`claude-*` → `claude`; local `ollama-cc/…`/ornith → `omp`), then the caller backend is inherited, with `claude` only as the final fallback. Explicit native-backend/model-family mismatches are REJECTED before terminals open; `omp` may still be selected explicitly for supported cloud providers.",
                      "type": "string",
                      "enum": [
                        "claude",
                        "omp",
                        "codex"
                      ]
                    },
                    "count": {
                      "description": "TARGET fleet size — NOT the number of new terminals to open (default 1). Only the DEFICIT opens: with N members already LIVE, count:M opens M−N, and a fleet already at M opens NOTHING (relaunchSuppressed:true). For a plan-scoped launch, an explicit target wider than the plan's currently executable DAG frontier is refused before fleet creation with requestedSeats/executableWidth/seatShortfall and exact blocker diagnostics. The full live-member deficit proceeds through governed admission; capacity may clamp it, so the fleet can end up SMALLER than count — read `fleetSize`/`shortfall` on the result, never the opened count alone. To ADD N members to a running fleet, pass count = liveMembers + N.",
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 9007199254740991
                    },
                    "placement": {
                      "description": "Where members run (default 'local': this machine, exactly as before). 'remote' places members on the OTHER machines that delegated agent_slot seats to this fleet OR to its pot (P-005: fleet-scoped and pot-scoped federated seat-offers are pooled together): `count` is spread round-robin across those machines — 1 per machine first, so count 2 across 2 machines lands 1 member on EACH — publishing one SIGNED spawn-request per target (the fleet:request_remote_spawn chain, which stays the single-target/explicit-pick door). ASYNC: members arrive only after each host's owner-authority accept-delegated-seats gate admits the request, AND — for a pot-scoped target — that host's audience check for the pot ('trusted-members'|'whole-pot') passes (a gate-off host, or an audience refusal, lets/leaves the request to expire after 60 min); watch arrivals via fleet:status / coord:presence, refusals via p2p:trace. Each machine's delegated slot pins the member's model+effort+account and the host owns the window shape, so agent/model/account/seat/headless/carry/display/per-member-brief args are REFUSED with 'remote'; `launchContext` still applies (sent as brief text, ≤8000 chars).",
                      "type": "string",
                      "enum": [
                        "local",
                        "remote"
                      ]
                    },
                    "hive": {
                      "description": "placement:'remote' on a MULTI-hive workspace: which shared hive's federated seat-offers to place onto (mirror of resource:delegate's `hive`). Defaults to the single shared hive, else to `harness` when that names a shared hive; otherwise the call refuses and lists the candidates.",
                      "type": "string"
                    },
                    "headless": {
                      "description": "Launch the members HEADLESS — background su sessions with NO desktop window (default false = visible terminals). Same su members (NOT cups), same leader-led contract, they register presence + count toward the fleet, auto-start on the plan, and stay injectable for warm loop:arm wakes; they just have no window and log to a file you can tail. EI-9748 FIXED (2026-07-11, live): on a systemd-managed Linux host (the normal case), each headless member is spawned via `systemd-run --user --scope`, which places it in a transient scope that is a SIBLING of the operator API's own service in the systemd --user cgroup tree — NOT a descendant — so `systemctl --user restart` of papercusp-dev-api/papercusp-staging-api (KillMode=control-group) cannot reap it; a headless member now survives those restarts just like a visible one. RESIDUAL CAVEAT: on a host with no `systemd-run` on PATH (macOS, a bare/non-systemd container), the spawn falls back to a plain detached child that DOES still share the operator process's cgroup and CAN be silently SIGTERM-killed by a restart of that service — a killed member's log says so. Headless is safe to prefer by default on Linux dev hosts; on a non-systemd host, prefer visible for anything that must survive hours unattended, or check on the fleet more often. Orthogonal to `carry`.",
                      "type": "boolean"
                    },
                    "leader": {
                      "description": "WHO LEADS the fleet (generic default 'caller' — you become leader, the historical behavior). Under GOAL context omission defaults to 'spawn' and explicit 'caller' is refused: a GOAL portfolio steward must never lead its plan fleet. 'spawn' launches a FRESH agent to lead it and leaves you out of the fleet entirely. Replaces the two-hop relay (launch an agent, brief it to call this tool itself) with one call. The spawned leader's coord identity is PRE-PINNED, so the fleet row names its real leader from the first write and there is never a window where you are recorded as leading. It is opened BEFORE any member, and if it fails to open the whole launch ABORTS with zero members — members draining a queue with no leader watching is worse than no fleet. Goal-context leaders and members bind their distinct launch-role profiles; explicit top-level/per-member choices still win.",
                      "type": "string",
                      "enum": [
                        "caller",
                        "spawn"
                      ]
                    },
                    "confirmRouteSwitch": {
                      "description": "Explicitly authorize moving the CALLER from its currently registered fleet into a different target fleet. Without this bit, a caller-led launch (`leader:'caller'`, the default) is refused before mutation when the caller already belongs to another fleet; use `leader:'spawn'` instead when the current fleet must keep its supervisor. This is an audit guard, not a convenience retry flag — read the refusal's currentFleet/targetFleet first.",
                      "type": "boolean"
                    },
                    "carry": {
                      "description": "Auto-mode carry for EVERY member (default 'warm'), INDEPENDENT of `headless`: 'warm' = each loop:arm wake resumes the SAME live context (fast, remembers the thread); 'cold' = each wake starts a FRESH context reconstructed from the member's last checkpoint (cheaper long-run, survives compaction, but the carry-note is the ONLY memory). Threads into the member baseline so a cold member arms `loop:arm { carry:'cold' }` and treats its checkpoint as load-bearing. ANNOUNCE the choice to the owner per the persona spawn-disclosure rule (alongside account + model).",
                      "type": "string",
                      "enum": [
                        "warm",
                        "cold"
                      ]
                    },
                    "supervise": {
                      "description": "R5 per-fleet governor grant: true opts THIS fleet into fleet-headcount auto-top-up by persisting `supervise: true` on its durable launch recipe (the governor acts only on granting fleets, and only while FLEET_HEADCOUNT_GOVERNOR is ON); false revokes; omit leaves the stored grant untouched. An undeliverable grant (paired/heterogeneous launch, or an existing fleet with no ENABLED headcount row) is reported on the result as `superviseGrant`, never silently dropped.",
                      "type": "boolean"
                    },
                    "overrideCapacityClamp": {
                      "description": "Treat the inference-pool capacity signal as a RECOMMENDATION, not a cap: launch all `count` members even when capacity would clamp them (including a pool reading healthyAccounts:0, which otherwise suppresses a gateway-routed launch to ZERO). The recommendation is still computed and reported (capacityClamp.recommendedOpenCount / overridden). Use when you believe the pool signal is STALE — but prefer FIXING the signal first: `accounts:probe-capacity` (store projection) and `POST /admin/readmit` (the gateway's in-memory exhaustion) are the real remedies. Default false.",
                      "type": "boolean"
                    },
                    "account": {
                      "description": "psu --account routing for EVERY member (account-routing-3-options) — one of three: a POOL ACCOUNT ID (from accounts:list / gateway:status) → pin every member to it via the inference gateway (isolate/concentrate the fleet's load; no failover); \"auto\" → route through the gateway, which auto-selects an available account + fails over; \"default\" → skip the gateway, use the system / CLI-login credential. OMIT defaults to \"default\" on every platform; gateway routing is never selected implicitly. (For a multi-account spread, launch in batches with different account ids.) ANNOUNCE the choice to the owner per the persona spawn-disclosure rule.",
                      "type": "string"
                    },
                    "workspace": {
                      "description": "psu --workspace: the workspace the fleet + every member launch under. Defaults to the launch session's workspace.",
                      "type": "string"
                    },
                    "role": {
                      "description": "psu --role: the su role each member runs as (default the standard su collaborator).",
                      "type": "string"
                    },
                    "stack": {
                      "description": "Repeatable psu --stack `slot:id` bindings for every member; members[].stack overrides this list.",
                      "maxItems": 40,
                      "type": "array",
                      "items": {
                        "type": "string",
                        "minLength": 1
                      }
                    },
                    "model": {
                      "description": "psu --model: a per-member model spec, e.g. \"opus:high\" (default the role/tier default). A LOCAL/gateway model (ollama-cc/…, ornith) is fuzzy-validated against the registered local backends — an invalid id returns the nearest registered model + the allowed list (generic-tool-arg-fuzzy-validation). A non-local (claude/codex) alias is the open set — full ids pass, but a malformed alias (a versioned shorthand like `sonnet-5`, or a typo) is caught + corrected.",
                      "type": "string"
                    },
                    "effort": {
                      "description": "Reasoning effort for EVERY member (low|medium|high|xhigh|max) — composed onto the model spec (`<model>:<effort>`); use `members[].effort` for a per-member override.",
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 40
                    },
                    "feature": {
                      "description": "psu --feature: a feature id each member should pick up.",
                      "type": "string"
                    },
                    "brief": {
                      "description": "Shared inline first-turn brief for every member. Unlike `launchContext`, this is always treated as text, never as a file path; it is layered below the universal member baseline.",
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 8000
                    },
                    "launchContext": {
                      "description": "psu --launch-context: PATH to a brief/markdown file injected as EVERY member's launch context (shared) — or, if the value contains a newline or is too long to plausibly be a filename, the brief TEXT itself (composed straight into the generated launch-context file; no read attempted). Use `perMemberLaunchContext` instead when different members need DISTINCT briefs.",
                      "type": "string"
                    },
                    "perMemberLaunchContext": {
                      "description": "Per-member brief paths, index-aligned to member number (entry 0 → member 1, …) — each member gets its OWN composed context. Fewer entries than members opened ⇒ the rest fall back to `launchContext`/baseline, never an error.",
                      "type": "array",
                      "items": {
                        "type": "string"
                      }
                    },
                    "members": {
                      "description": "DECLARATIVE per-member config, index-aligned to member number (entry 0 → member 1, …). Each set field OVERRIDES the fleet-wide arg for THAT member only; an unset field falls through to the fleet arg, then the system default. Fewer entries than members opened ⇒ the rest use the flat fleet-wide args, never an error. This generalizes `perMemberLaunchContext` (brief-only) to every setting — use it to run one fleet where members differ in model/effort/account/limit/lane.",
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "model": {
                            "description": "psu --model: this member's model spec, overriding the fleet `model`.",
                            "type": "string"
                          },
                          "effort": {
                            "description": "Reasoning effort for this member. Composed onto the model spec (`<model>:<effort>`) — psu has no separate --effort flag — so it REQUIRES a model (this member's or the fleet's).",
                            "type": "string",
                            "enum": [
                              "low",
                              "medium",
                              "high",
                              "xhigh",
                              "max"
                            ]
                          },
                          "account": {
                            "description": "psu --account: this member's account routing (<pool-id>|auto|default).",
                            "type": "string"
                          },
                          "carry": {
                            "description": "This member's warm/cold auto-mode carry.",
                            "type": "string",
                            "enum": [
                              "warm",
                              "cold"
                            ]
                          },
                          "contextSize": {
                            "description": "psu --context-size for this member (growable trimmed seed).",
                            "type": "string",
                            "const": "trimmed"
                          },
                          "compactionLimit": {
                            "description": "psu --compaction-limit: this member's soft compaction limit in TOKENS (>= 20000). Clamped down to the fleet-role ceiling at seed time — it can lower a member's limit, never raise it past its cap.",
                            "type": "integer",
                            "minimum": 20000,
                            "maximum": 9007199254740991
                          },
                          "role": {
                            "description": "psu --role: a registered persona id resolved against the target harness (the valid ids are harness-specific). Discover exact ids first with roles:list { harnessSlug: \"<target>\" } and read roles[].id; roles:known lists built-in ids. This is not a lane/job label; put lane direction in this member's `brief` or the shared `label`.",
                            "type": "string"
                          },
                          "stack": {
                            "description": "Repeatable psu --stack `slot:id` bindings for this member. Replaces the fleet-wide `stack` when set.",
                            "maxItems": 40,
                            "type": "array",
                            "items": {
                              "type": "string",
                              "minLength": 1
                            }
                          },
                          "agent": {
                            "description": "psu --agent (claude|omp|codex) for this member.",
                            "type": "string"
                          },
                          "launchContext": {
                            "description": "psu --launch-context: this member's own brief FILE path.",
                            "type": "string"
                          },
                          "brief": {
                            "description": "Inline brief TEXT for this member — becomes its own first turn / composed launch context. Use instead of `launchContext` when you have the text, not a file. Takes precedence over this member's `perMemberLaunchContext` entry.",
                            "type": "string"
                          },
                          "claimKinds": {
                            "description": "Per-member claim lane — seeds THIS member's claim spec, overriding the fleet-level `claimKinds`.",
                            "minItems": 1,
                            "maxItems": 5,
                            "type": "array",
                            "items": {
                              "type": "string",
                              "enum": [
                                "feature",
                                "chunk",
                                "bug",
                                "change",
                                "task",
                                "cleanup"
                              ]
                            }
                          },
                          "headless": {
                            "description": "Launch this member headless (no window).",
                            "type": "boolean"
                          },
                          "addDir": {
                            "description": "psu --add-dir entries for this member.",
                            "type": "array",
                            "items": {
                              "type": "string"
                            }
                          },
                          "allowSubagents": {
                            "description": "psu --allow-subagents for this member.",
                            "type": "boolean"
                          },
                          "brain": {
                            "description": "psu --brain for this member.",
                            "type": "boolean"
                          },
                          "feature": {
                            "description": "psu --feature for this member.",
                            "type": "string"
                          },
                          "profile": {
                            "description": "psu --profile for this member.",
                            "type": "string"
                          },
                          "display": {
                            "description": "Open this member's terminal on this X display.",
                            "type": "string"
                          },
                          "extraArgs": {
                            "description": "Extra verbatim psu args for this member.",
                            "type": "array",
                            "items": {
                              "type": "string"
                            }
                          }
                        },
                        "additionalProperties": false
                      }
                    },
                    "profile": {
                      "description": "psu --profile: launch profile name for each member.",
                      "type": "string"
                    },
                    "contextSize": {
                      "description": "psu --context-size for EVERY member. 'trimmed' seeds the growable core tool surface; 'steward' (WI-2140338, explicit opt-in) adds the steward verb families for goal-holder/steward lanes. Both stay growable — tools:find/tools:invoke retain reachability to the full catalog.",
                      "type": "string",
                      "enum": [
                        "trimmed",
                        "steward"
                      ]
                    },
                    "compactionLimit": {
                      "description": "psu --compaction-limit for EVERY member. A persisted fleet headcount profile reuses this value for launch, respawn, and governor restoration instead of reconstructing it per wave.",
                      "type": "integer",
                      "minimum": 20000,
                      "maximum": 900000
                    },
                    "brain": {
                      "description": "psu --brain: launch each member in brain mode.",
                      "type": "boolean"
                    },
                    "addDir": {
                      "description": "psu --add-dir (repeatable): extra directories added to each member's workspace.",
                      "type": "array",
                      "items": {
                        "type": "string"
                      }
                    },
                    "allowSubagents": {
                      "description": "psu --allow-subagents (default OFF): opt every member's su session back IN to its own built-in subagent-launch (Task/Agent) tool. Subagents are DENIED BY DEFAULT for every psu launch (owner mandate 2026-07-02), so members CANNOT fan out unless this is true.",
                      "type": "boolean"
                    },
                    "fromSeats": {
                      "description": "P-005 launch-from-seats (agent-allocation-framework): spawn members that CONSUME the fleet's delegated agent_slot seats (resource:delegate / the /res Agent-seats group). The slot pins model+effort+account (D-002/D-003) — so `model`/`account` must be OMITTED — and the seat COUNT cap is enforced (count > free seats is refused; the N+1th spawn is refused at boot too). Implied by `seat`.",
                      "type": "boolean"
                    },
                    "seat": {
                      "description": "Which delegated slot template to launch from, as its ref '<model>:<effort>:<account>' (e.g. 'opus:xhigh:AUTO'). Required only when the fleet has MORE THAN ONE delegated template; a single template is picked automatically with `fromSeats: true`.",
                      "type": "string"
                    },
                    "extraArgs": {
                      "description": "Escape hatch for any other psu flag: each element is one full token (e.g. [\"--yes\", \"--add-dir=/x\"]), appended verbatim to every member's psu launch — covers psu args without a first-class field above.",
                      "type": "array",
                      "items": {
                        "type": "string"
                      }
                    },
                    "display": {
                      "description": "WI-4272 (demo/recording): open EVERY member terminal on this X display (e.g. ':110' — a computer:provision_desktop sandbox stage being recorded) instead of the owner's desktop seat. Linux only; requires a DISPLAY-honoring emulator (xterm/alacritty/kitty/wezterm) and the display's X socket to be alive (loud-fail otherwise). Ignored for `headless: true` (headless members have no window). Omit for normal visible-desktop use.",
                      "type": "string"
                    },
                    "claimKinds": {
                      "description": "EI-7671: restrict every member's scheduler:get_next self-pull to these work-item kinds — e.g. [\"bug\",\"change\"] for a bugs-only backlog-drain fleet. Sets a FLEET-level claim spec BEFORE any member terminal opens, closing the boot-race where members start pulling under the empty-filter DEFAULT_CLAIM_SPEC (which admits every kind, including feature/chunk) before the leader gets around to calling scheduler:set_claim_spec by hand. A member's own later per-bee spec still overrides this fleet default. Omit to leave scheduling exactly as before (no spec set).",
                      "minItems": 1,
                      "maxItems": 5,
                      "type": "array",
                      "items": {
                        "type": "string",
                        "enum": [
                          "feature",
                          "chunk",
                          "bug",
                          "change",
                          "task",
                          "cleanup"
                        ]
                      }
                    },
                    "confirmClaimCollapse": {
                      "description": "P-010 pool-collapse override: a `claimKinds` fleet is REFUSED at launch (BEFORE any terminal opens) when its kind-scoped claim spec matches 0 rows of a nonempty claimable pool — the silent bug-drain starvation shape (WI-5212/EI-11300). Pass true ONLY after reading the refusal's reported counts and confirming the empty lane is intended (e.g. a pre-staged fleet whose items are not promoted yet). Ignored when no `claimKinds` is given.",
                      "type": "boolean"
                    },
                    "confirmKickoffMismatch": {
                      "description": "EI-18862608742257943 override: the launch is REFUSED (BEFORE any terminal opens, LOCAL placement only) when a WI-/EI- id referenced in `launchContext` / `perMemberLaunchContext` / `members[].brief` does not match the fleet claim spec this launch is about to apply — a member kicked off with \"your only job is WI-xxxx\" that cannot then claim WI-xxxx (assignee stays NULL, presence shows it holding nothing, the death-resilience net never engages). Pass true to launch anyway (e.g. the brief only MENTIONS the id for context, or you will widen the spec by hand right after); otherwise fix the claimKinds/plan scope or drop the id from the brief.",
                      "type": "boolean"
                    }
                  },
                  "required": [
                    "name"
                  ],
                  "additionalProperties": false,
                  "$defs": {
                    "0": {
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 9007199254740991
                    },
                    "1": {
                      "type": "string",
                      "enum": [
                        "claude",
                        "omp",
                        "codex"
                      ]
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
                "name": "coord:declare-intent",
                "description": "Declare current work: one-line intent, optional plan slug, P-NNN lane (auto-claimed), files, optional typed goal refs, and optional ambient-retrieval exclusions. `items` accepts plan ids in P-NNN form only; scheduler:get_next claims WI-/EI- work-items and declares their intent automatically, so do not pass those ids here. A non-empty `items` lane requires a plan slug; an explicit empty `items: []` may be used without one for a replacement-member presence re-declaration and does not touch plan claims. Peers see this via coord:presence / fleet:assignments. Omitted fields reset state except `items`, `current_files`, and `ambient_excluded_refs` (omission preserves; [] clears). A broad \"all remaining items\" intent without structured `items` returns advisory `overCoverageHint` (EI-5873).",
                "inputSchema": {
                  "type": "object",
                  "properties": {
                    "intent": {
                      "type": "string",
                      "minLength": 1,
                      "description": "One line: what you are working on right now."
                    },
                    "current_plan_slug": {
                      "description": "Plan slug this work belongs to, if any; null is treated like omission.",
                      "anyOf": [
                        {
                          "type": "string"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "items": {
                      "description": "P-NNN plan items you are taking (your LANE) — each is auto-claimed; your other claims in this plan are released. A non-empty lane requires current_plan_slug. Pass [] with a plan to release your whole lane; pass [] without a plan for a replacement-member presence re-declaration that does not touch plan claims. Omit to leave claims untouched. WI-/EI- work-item ids belong to scheduler:get_next, not this field.",
                      "maxItems": 40,
                      "type": "array",
                      "items": {
                        "type": "string",
                        "pattern": "^P-\\d{3,}$"
                      }
                    },
                    "declared_goal_refs": {
                      "description": "Optional typed goal refs explicitly covered by this declaration — generated goal slugs and WI-/EI- work-item refs are accepted; blank and bare numeric refs are rejected. Omit when no multi-goal declaration is intended; prose is never inferred.",
                      "minItems": 1,
                      "maxItems": 40,
                      "type": "array",
                      "items": {
                        "type": "string",
                        "minLength": 1
                      }
                    },
                    "harness": {
                      "description": "Harness the plan lives in, for the item claims (default: session harness, or operator home if unscoped).",
                      "type": "string",
                      "maxLength": 120
                    },
                    "current_files": {
                      "description": "Repo-relative files currently in scope — read by lock-contention enrichment (is the holder still focused on this path?) and by fleet placement. Omit to leave your declared file set untouched; pass [] to clear it. Same omission semantics as `items`.",
                      "type": "array",
                      "items": {
                        "type": "string"
                      }
                    },
                    "ambient_excluded_refs": {
                      "description": "Work-item/session refs that ambient corpus retrieval must never inject into this session. Omit to preserve the durable fence; pass [] to clear it. A read failure fails closed for corpus retrieval.",
                      "type": "array",
                      "items": {
                        "type": "string"
                      }
                    }
                  },
                  "required": [
                    "intent"
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
                "name": "events:status",
                "description": "Inspect the await-event surface: your active wake awaits, standing event-key inject subscriptions, trees, and recent wakes, or pass an exact event key for its declaration generations, expected condition, waiter registrations, wake outcomes, and a deterministic watermark/resync verdict. Exact-key waiter rows are under event_inspection.waiters; generic and await_id responses use active_awaits. Exact-key history is a bounded recent window; history_window reports omitted rows. Optionally include the fleet-wide wake meter. Evidence-only judges may inspect only their own awaits and recent wakes; exact-key inspection and the fleet-wide meter are unavailable. Workspace-global read surface: scope comes from request context and caller identity; do not pass `harness` or `workspace` as JSON arguments (those keys are rejected).",
                "inputSchema": {
                  "type": "object",
                  "anyOf": [
                    {
                      "type": "object",
                      "properties": {
                        "meter": {
                          "description": "Include the wake meter (per-agent counts by status/channel, 24h; events:await is single-workspace by design, so this is fleet-wide, not scoped to your workspace).",
                          "type": "boolean"
                        },
                        "await_id": {
                          "type": "integer",
                          "exclusiveMinimum": 0,
                          "maximum": 9007199254740991,
                          "description": "Filter active awaits and recent wake deliveries to the id returned by events:await. The generic/await_id response lists registrations under active_awaits. A targeted recent delivery includes its payload (capped at 2000 characters). Mutually exclusive with `event`."
                        },
                        "event": {
                          "description": "Only valid for exact event-key inspection; mutually exclusive with `await_id`.",
                          "not": {}
                        },
                        "after_generation": {
                          "description": "Only valid with an exact `event` key.",
                          "not": {}
                        }
                      },
                      "required": [
                        "await_id"
                      ],
                      "additionalProperties": false
                    },
                    {
                      "type": "object",
                      "properties": {
                        "meter": {
                          "description": "Include the wake meter (per-agent counts by status/channel, 24h; events:await is single-workspace by design, so this is fleet-wide, not scoped to your workspace).",
                          "type": "boolean"
                        },
                        "await_id": {
                          "description": "Only valid for await-id inspection; mutually exclusive with `event`.",
                          "not": {}
                        },
                        "event": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 200,
                          "description": "Exact event key to inspect across declarations, waiter registrations, and wake outcomes. Exact-key waiter rows are under event_inspection.waiters (with state and expires_ts), not active_awaits. Mutually exclusive with `await_id`."
                        },
                        "after_generation": {
                          "description": "Your cached declaration generation for `event`. The response says whether it is stale and how to resync.",
                          "type": "integer",
                          "minimum": 0,
                          "maximum": 9007199254740991
                        }
                      },
                      "required": [
                        "event"
                      ],
                      "additionalProperties": false
                    },
                    {
                      "type": "object",
                      "properties": {
                        "meter": {
                          "description": "Include the wake meter (per-agent counts by status/channel, 24h; events:await is single-workspace by design, so this is fleet-wide, not scoped to your workspace).",
                          "type": "boolean"
                        },
                        "await_id": {
                          "description": "Only valid for await-id inspection; mutually exclusive with `event`.",
                          "not": {}
                        },
                        "event": {
                          "description": "Only valid for exact event-key inspection; mutually exclusive with `await_id`.",
                          "not": {}
                        },
                        "after_generation": {
                          "description": "Only valid with an exact `event` key.",
                          "not": {}
                        }
                      },
                      "additionalProperties": false
                    }
                  ]
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
                "name": "coord:orient",
                "description": "Wake/session bootstrap in one read: assignments and load, claimable work, inbox, plan events, and fleet health. With `intent`, it also recalls memory and declares the intent. Fleet and workspace are inferred; an optional `fleet` is a compatibility hint only and does not override session membership; pass `harness` only for explicit harness scope.",
                "inputSchema": {
                  "type": "object",
                  "properties": {
                    "harness": {
                      "description": "Scope assignments + claimable + recall + declare to this harness.",
                      "type": "string",
                      "maxLength": 80
                    },
                    "fleet": {
                      "description": "Optional compatibility hint from older launch/checkpoint callers; membership remains session-inferred.",
                      "type": "string",
                      "maxLength": 120
                    },
                    "claimableState": {
                      "description": "Work-item state for the claimable list (default 'open' — the unified claimable token).",
                      "type": "string",
                      "maxLength": 40
                    },
                    "claimableLimit": {
                      "description": "Max claimable items (default 20; 0 skips backlog enumeration).",
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 100
                    },
                    "inboxLimit": {
                      "description": "Max recent inbox entries (default 10; 0 skips the inbox read).",
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 50
                    },
                    "includeFleet": {
                      "description": "Deprecated alias for the optional fleet folds; false skips both fleet catch-up and fleet health. Explicit canonical controls win.",
                      "type": "boolean"
                    },
                    "includeInbox": {
                      "description": "Deprecated alias for inboxLimit; false maps to inboxLimit=0 unless inboxLimit is explicit.",
                      "type": "boolean"
                    },
                    "includeAssignments": {
                      "description": "Deprecated no-op accepted for compatibility; assignments are a core orient fold and are always retained.",
                      "type": "boolean"
                    },
                    "mode": {
                      "description": "Default 'full'. Pass 'monitor' for a repeating leader/monitor loop tick: skips the claimable backlog, plan-events delta, fleet catch-up, recipes search, and memory recall ENTIRELY (no sub-call, not just capped output) — keeps fleet:assignments (the live/parked/stalled/orphaned counts a monitor loop watches), the inbox read, and coord:declare-intent (when `intent` is passed). The facts fold is NARROWED, not skipped: `dead-end:`/`wall:`/`guard-rail:` still fold every tick (marked `factsNarrowed`); afterCompaction:true forces the full fold. A resolvable FLEET LEADER also gets `leaderBrief` (fleet:leader-brief) folded in — the whole fleet's per-member sessionState/verdict/claims/unanswered/contextPressure in this same round-trip. Sharply cuts per-wake context/token cost for a long-running monitor loop (EI-8300).",
                      "type": "string",
                      "enum": [
                        "full",
                        "monitor"
                      ]
                    },
                    "intent": {
                      "description": "Your one-line intent for this turn — DECLARED to peers (coord:declare-intent) AND used as the memory:search recall query. The bootstrap-in-one-call lever.",
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 2000
                    },
                    "declared_goal_refs": {
                      "description": "Optional typed goal refs explicitly covered by the declared intent — generated goal slugs and WI-/EI- work-item refs are accepted; blank and bare numeric refs are rejected. Omission preserves the untyped path.",
                      "minItems": 1,
                      "maxItems": 40,
                      "type": "array",
                      "items": {
                        "type": "string",
                        "minLength": 1
                      }
                    },
                    "currentFiles": {
                      "description": "Explicit repository-relative files for a bounded task brief when the declared intent has no held work-item.",
                      "maxItems": 20,
                      "type": "array",
                      "items": {
                        "type": "string"
                      }
                    },
                    "memoryQuery": {
                      "description": "Explicit memory:search query (overrides `intent` for recall).",
                      "type": "string",
                      "maxLength": 500
                    },
                    "planSlug": {
                      "description": "Plan slug for the declared lane (used with `intent`); null is equivalent to omission for planless lanes.",
                      "anyOf": [
                        {
                          "type": "string",
                          "maxLength": 120
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "planItems": {
                      "description": "Plan items to claim as your lane (used with `intent` + `planSlug`).",
                      "maxItems": 40,
                      "type": "array",
                      "items": {
                        "type": "string",
                        "maxLength": 20
                      }
                    },
                    "memoryLimit": {
                      "description": "Max memory hits to fold (default 5; 0 skips memory recall).",
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 10
                    },
                    "memoryIncludeSuperseded": {
                      "description": "Explicit history recall: include superseded/soft-forgotten memories in the memory fold. Default false. Returned superseded bodies are prefixed [SUPERSEDED YYYY-MM-DD].",
                      "type": "boolean"
                    },
                    "includePlanEvents": {
                      "description": "Fold the recent plan-events delta (default true).",
                      "type": "boolean"
                    },
                    "planEventsSince": {
                      "description": "Only plan-events strictly after this ISO timestamp.",
                      "type": "string"
                    },
                    "includeRecipes": {
                      "description": "Surface reusable code:run recipes relevant to `intent` (default true).",
                      "type": "boolean"
                    },
                    "recipesLimit": {
                      "description": "Max relevant recipes to surface (default 3; 0 skips recipe search).",
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 5
                    },
                    "includePeersKnow": {
                      "description": "Fold a peers-know hint when your declared `intent` semantically matches a CLOSED consult in the archive: the settled answer one-liner + source consult + a consult:get_feedback pointer (default true; absent on no-match — zero cost).",
                      "type": "boolean"
                    },
                    "includeFleetCatchUp": {
                      "description": "Fold a bounded catch-up of YOUR fleet's audience-history when you're in a named fleet (default true).",
                      "type": "boolean"
                    },
                    "fleetCatchUpLimit": {
                      "description": "Max fleet catch-up messages to fold (default 8; 0 skips the catch-up fold).",
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 25
                    },
                    "includeFleetHealth": {
                      "description": "Fold a COMPACT fleet-health glance (bees running/working, staged wakes, paused governor buckets) when you're in a named fleet (default true; full mode only) — the coord:glance health read agents otherwise re-fetch right after orient.",
                      "type": "boolean"
                    },
                    "afterCompaction": {
                      "description": "Pass true on your FIRST orient after a compaction: folds a recovery block — your held work-items’ checkpoints, armed-loop status, staleness_warnings (presence/fleet/claims that changed AFTER your summary was written — the summary’s view of them is stale), and the self-recall pointer (pre-compaction turns are searchable via sessions:search { session:’self’ }).",
                      "type": "boolean"
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
                "name": "coord:send",
                "description": "coord:send. Directed action/answer requires `body[].forYouBecause: { relation, ref?, note? }`. `summary` is the required inbox headline. `items:[…]` sends distinct messages. `why`={goalRef,note?}, not prose. `basedOn` is OUTPUT-ONLY, auto-derived; omit it. `body[].premises` are ref strings; `body[].youMayNotKnow` uses {ref, provenance} objects — put that shape in `body[].youMayNotKnow`, not in `body[].premises`. `wake` re-invokes recipients; `optimistic` needs `backstop`.",
                "inputSchema": {
                  "type": "object",
                  "properties": {
                    "to": {
                      "minItems": 1,
                      "type": "array",
                      "items": {
                        "type": "string",
                        "minLength": 1
                      }
                    },
                    "summary": {
                      "type": "string",
                      "minLength": 1,
                      "description": "REQUIRED for the single-message form (when `items` is omitted); omit only when sending via `items:[…]`. One-line inbox headline — `body` is optional long-form detail and does not replace it."
                    },
                    "harness": {
                      "$ref": "#/$defs/7"
                    },
                    "body": {
                      "$ref": "#/$defs/coord-send-body-v1"
                    },
                    "conditionKey": {
                      "$ref": "#/$defs/9"
                    },
                    "resolvesCondition": {
                      "description": "Resolve a coord:conditions alarm previously raised by this authenticated sender with conditionKey. Pass the same raw key.",
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 512
                    },
                    "blocking": {
                      "description": "ENVELOPE. Optional BOOLEAN flag: pass the literal `true` or `false`. Is the SENDER blocked until this is dealt with? A scheduler acts on a message as a UNIT, which is why this cannot vary per section. Distinct from `expects`: `expects` is what you want BACK, `blocking` is what it costs you to wait for it. Do not put explanatory prose in this field; put the explanation in `body` section text and a checkable blocker in `body[].blockedOn`.",
                      "type": "boolean"
                    },
                    "why": {
                      "$ref": "#/$defs/6"
                    },
                    "basedOn": {
                      "description": "OUTPUT-ONLY — `basedOn` is auto-derived from this session's recent reads and stamped on the envelope after validation. Never author or pass it; omit this field. Use `body[].premises` for authored claim references.",
                      "not": {}
                    },
                    "fieldProvenance": {
                      "$ref": "#/$defs/8"
                    },
                    "files": {
                      "type": "array",
                      "items": {
                        "type": "string"
                      }
                    },
                    "plan_slug": {
                      "type": "string"
                    },
                    "related_msg_id": {
                      "description": "Replying? The full msg_id you are answering (or a UNIQUE leading prefix copied from coord:inbox) — this fires the asker's wake-on-reply. The server persists the canonical full id; dangling or ambiguous refs refuse the send (related_msg_not_found / related_msg_ambiguous). Never hand-type or use a placeholder.",
                      "type": "string"
                    },
                    "expects": {
                      "$ref": "#/$defs/1"
                    },
                    "relayOf": {
                      "description": "Relaying someone else's directive/decision? Pass the ORIGINAL's coord msg_id — or the literal sentinel 'owner-turn' when relaying what the owner told you in your CURRENT turn (a TUI human turn has no msg_id). The platform verifies the reference SERVER-SIDE at send, stamps the provenance tier (coord-origin / owner-verified(turn)) and auto-inlines a bounded VERBATIM quote at delivery — receivers see the original's words, never your paraphrase, and neither side makes an extra call. A dangling msg_id is a loud relay_origin_not_found (nothing sent).",
                      "type": "string"
                    },
                    "relayQuote": {
                      "description": "Relay-provenance Tier 3 (older turns 'owner-turn' can't reach): a VERBATIM snippet of the owner turn you are relaying. Verified against your own transcript's human turns — hit → stamped owner-verified(transcript-match); miss → still delivered, stamped 'UNVERIFIED relay'.",
                      "type": "string"
                    },
                    "gateRefs": {
                      "$ref": "#/$defs/4"
                    },
                    "noBodyRefs": {
                      "description": "P-008 body auto-refs OPT-OUT: by default, WI-/EI- ids mentioned in your summary/body auto-hydrate at delivery into a one-line live status+title+checkpoint suffix on the receiver's [coord+N] line (first 3 ids, ~150 chars each — receivers stop re-fetching cited items). Set true when that live status would MISLEAD: the ids are historical/illustrative examples, or you are deliberately quoting stale state.",
                      "type": "boolean"
                    },
                    "wake": {
                      "$ref": "#/$defs/3"
                    },
                    "wakeOnReply": {
                      "description": "When a peer REPLIES to this message (their coord:send sets related_msg_id to this message's msg_id), wake YOU (the sender) so you re-invoke the moment the reply lands — the dual of waking the recipient. Default: ON for DIRECTED sends whose expects is ack/answer/action; OFF for expects:'none' and broadcasts (to '*'/'human'). Set true to opt a fire-and-forget message into reply wakes, or false to opt out.",
                      "type": "boolean"
                    },
                    "replyDeadlineSec": {
                      "description": "EI-8986: \"nudge if silent\" — the dual of wakeOnReply (which wakes you when a reply ARRIVES; this wakes you when one does NOT). If no reply lands within this many seconds, a periodic backstop sweep nudges you ONCE: a coord message + a fail-soft wake — never a recurring alarm. Independent of wakeOnReply — set either, both, or neither. Omit for no deadline tracking (today's behavior).",
                      "type": "number",
                      "exclusiveMinimum": 0
                    },
                    "endTurn": {
                      "description": "Escape addressees' current turns BEFORE delivery, only when confirmed STUCK, then wake a fresh turn. `endTurn: true` REQUIRES an explicit wake mode: `wake: true`, `wake: 'required'`, or `wake: 'optimistic'`; omitted wake or `wake: false` is refused. Audited and storm-rate-limited. Skips '*'/'human'/self. `ended` excludes targets confirmed dead by the wake liveness check: they appear in `missed` even if Escape succeeded.",
                      "type": "boolean"
                    },
                    "backstop": {
                      "description": "FF#1: name the DURABLE BACKSTOP you verified will re-dispatch a wake:'optimistic' miss. Optimistic stays silent-on-miss ONLY when you declare one; WITHOUT a backstop an optimistic miss is reported as loudly as a required miss (recipient_absent). Do NOT pass a fake or assumed backstop to silence the warning — that re-creates the dead-drop trap. No effect on wake:'required' / inject.",
                      "type": "string",
                      "minLength": 1
                    },
                    "scope": {
                      "description": "Federation scope of THIS message (cross-machine-coord-parity P-001). Omitted = auto: a harness-scoped sender stamps its harness; an un-scoped (SU/operator) sender in a workspace with EXACTLY ONE shared Hive stamps that Hive's home (the message federates to the Hive's other machines); otherwise the message stays machine-local. 'hive' FORCES the shared-Hive scope — errors loudly (no_hive_scope / ambiguous_hive_scope + candidates) instead of silently staying local. 'local' keeps the message on this machine only. Every result reports `federated:` so a local-only send is never mistaken for cross-machine delivery.",
                      "type": "string",
                      "enum": [
                        "hive",
                        "local"
                      ]
                    },
                    "hive": {
                      "$ref": "#/$defs/5"
                    },
                    "allHive": {
                      "description": "fleet-scoped-broadcast-default: consciously claim a HIVE-WIDE broadcast. If YOU are in a fleet, a bare to:['*'] is auto-scoped to your fleet (@fleet:<slug>, leader included) so routine status doesn't flood every agent — the result reports the rewrite as `scopedBroadcast`. Set allHive:true to keep '*' literal and reach EVERY agent, for system-wide issues / urgent notices only. No effect for a non-fleeted sender or a directed send.",
                      "type": "boolean"
                    },
                    "asAuthority": {
                      "description": "Renounce your fleet-control authority for THIS message — it is delivered UNSTAMPED, as an ordinary agent. A fleet LEADER needs this to send a hive-wide NOTICE (to:['*'] + allHive:true), which is otherwise refused as fleet_scoped_cue_allhive_contradiction: a leader may INFORM the hive, never COMMAND it. Do NOT use it to push a fleet-control cue (drain/pause/steer) past that guard. No effect for a sender holding no fleet-leader authority.",
                      "type": "string",
                      "const": "none"
                    },
                    "report": {
                      "$ref": "#/$defs/0"
                    },
                    "expectEffect": {
                      "$ref": "#/$defs/2"
                    },
                    "items": {
                      "description": "send many DISTINCT messages at once — each { to, summary, expects, harness?, body?, files?, plan_slug?, conditionKey?, resolvesCondition?, related_msg_id?, wake?, wakeOnReply?, endTurn? }; a top-level `harness` is the default for items that omit it — `expects` is required on EVERY item",
                      "minItems": 1,
                      "maxItems": 100,
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "to": {
                            "minItems": 1,
                            "type": "array",
                            "items": {
                              "type": "string",
                              "minLength": 1
                            }
                          },
                          "summary": {
                            "type": "string",
                            "minLength": 1,
                            "description": "REQUIRED for the single-message form (when `items` is omitted); omit only when sending via `items:[…]`. One-line inbox headline — `body` is optional long-form detail and does not replace it."
                          },
                          "harness": {
                            "$ref": "#/$defs/7"
                          },
                          "body": {
                            "$ref": "#/$defs/coord-send-body-v1"
                          },
                          "conditionKey": {
                            "$ref": "#/$defs/9"
                          },
                          "resolvesCondition": {
                            "description": "Resolve a coord:conditions alarm previously raised by this authenticated sender with conditionKey. Pass the same raw key.",
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 512
                          },
                          "blocking": {
                            "description": "ENVELOPE. Optional BOOLEAN flag: pass the literal `true` or `false`. Is the SENDER blocked until this is dealt with? A scheduler acts on a message as a UNIT, which is why this cannot vary per section. Distinct from `expects`: `expects` is what you want BACK, `blocking` is what it costs you to wait for it. Do not put explanatory prose in this field; put the explanation in `body` section text and a checkable blocker in `body[].blockedOn`.",
                            "type": "boolean"
                          },
                          "why": {
                            "$ref": "#/$defs/6"
                          },
                          "basedOn": {
                            "description": "OUTPUT-ONLY — `basedOn` is auto-derived from this session's recent reads and stamped on the envelope after validation. Never author or pass it; omit this field. Use `body[].premises` for authored claim references.",
                            "not": {}
                          },
                          "files": {
                            "type": "array",
                            "items": {
                              "type": "string"
                            }
                          },
                          "plan_slug": {
                            "description": "Usually AUTO-DERIVED — omit it. The seam stamps your declared plan (coord:orient { planSlug }); pass this only to attribute the message to a DIFFERENT plan.",
                            "type": "string"
                          },
                          "related_msg_id": {
                            "description": "Replying? The full msg_id you are answering (or a UNIQUE leading prefix copied from coord:inbox) — this fires the asker's wake-on-reply. The server persists the canonical full id; dangling or ambiguous refs refuse the send (related_msg_not_found / related_msg_ambiguous). Never hand-type or use a placeholder.",
                            "type": "string"
                          },
                          "expects": {
                            "$ref": "#/$defs/1"
                          },
                          "relayOf": {
                            "description": "Relaying someone else's directive/decision? Pass the ORIGINAL's coord msg_id — or the literal sentinel 'owner-turn' when relaying what the owner told you in your CURRENT turn (a TUI human turn has no msg_id). The platform verifies the reference SERVER-SIDE at send, stamps the provenance tier (coord-origin / owner-verified(turn)) and auto-inlines a bounded VERBATIM quote at delivery — receivers see the original's words, never your paraphrase, and neither side makes an extra call. A dangling msg_id is a loud relay_origin_not_found (nothing sent).",
                            "type": "string"
                          },
                          "relayQuote": {
                            "description": "Relay-provenance Tier 3 (older turns 'owner-turn' can't reach): a VERBATIM snippet of the owner turn you are relaying. Verified against your own transcript's human turns — hit → stamped owner-verified(transcript-match); miss → still delivered, stamped 'UNVERIFIED relay'.",
                            "type": "string"
                          },
                          "gateRefs": {
                            "$ref": "#/$defs/4"
                          },
                          "noBodyRefs": {
                            "description": "P-008 body auto-refs OPT-OUT: by default, WI-/EI- ids mentioned in your summary/body auto-hydrate at delivery into a one-line live status+title+checkpoint suffix on the receiver's [coord+N] line (first 3 ids, ~150 chars each — receivers stop re-fetching cited items). Set true when that live status would MISLEAD: the ids are historical/illustrative examples, or you are deliberately quoting stale state.",
                            "type": "boolean"
                          },
                          "wake": {
                            "$ref": "#/$defs/3"
                          },
                          "wakeOnReply": {
                            "description": "When a peer REPLIES to this message (their coord:send sets related_msg_id to this message's msg_id), wake YOU (the sender) so you re-invoke the moment the reply lands — the dual of waking the recipient. Default: ON for DIRECTED sends whose expects is ack/answer/action; OFF for expects:'none' and broadcasts (to '*'/'human'). Set true to opt a fire-and-forget message into reply wakes, or false to opt out.",
                            "type": "boolean"
                          },
                          "replyDeadlineSec": {
                            "description": "EI-8986: \"nudge if silent\" — the dual of wakeOnReply (which wakes you when a reply ARRIVES; this wakes you when one does NOT). If no reply lands within this many seconds, a periodic backstop sweep nudges you ONCE: a coord message + a fail-soft wake — never a recurring alarm. Independent of wakeOnReply — set either, both, or neither. Omit for no deadline tracking (today's behavior).",
                            "type": "number",
                            "exclusiveMinimum": 0
                          },
                          "endTurn": {
                            "description": "Escape addressees' current turns BEFORE delivery, only when confirmed STUCK, then wake a fresh turn. `endTurn: true` REQUIRES an explicit wake mode: `wake: true`, `wake: 'required'`, or `wake: 'optimistic'`; omitted wake or `wake: false` is refused. Audited and storm-rate-limited. Skips '*'/'human'/self. `ended` excludes targets confirmed dead by the wake liveness check: they appear in `missed` even if Escape succeeded.",
                            "type": "boolean"
                          },
                          "backstop": {
                            "description": "FF#1: name the DURABLE BACKSTOP you verified will re-dispatch a wake:'optimistic' miss. Optimistic stays silent-on-miss ONLY when you declare one; WITHOUT a backstop an optimistic miss is reported as loudly as a required miss (recipient_absent). Do NOT pass a fake or assumed backstop to silence the warning — that re-creates the dead-drop trap. No effect on wake:'required' / inject.",
                            "type": "string",
                            "minLength": 1
                          },
                          "scope": {
                            "description": "Federation scope of THIS message (cross-machine-coord-parity P-001). Omitted = auto: a harness-scoped sender stamps its harness; an un-scoped (SU/operator) sender in a workspace with EXACTLY ONE shared Hive stamps that Hive's home (the message federates to the Hive's other machines); otherwise the message stays machine-local. 'hive' FORCES the shared-Hive scope — errors loudly (no_hive_scope / ambiguous_hive_scope + candidates) instead of silently staying local. 'local' keeps the message on this machine only. Every result reports `federated:` so a local-only send is never mistaken for cross-machine delivery.",
                            "type": "string",
                            "enum": [
                              "hive",
                              "local"
                            ]
                          },
                          "hive": {
                            "$ref": "#/$defs/5"
                          },
                          "allHive": {
                            "description": "fleet-scoped-broadcast-default: consciously claim a HIVE-WIDE broadcast. If YOU are in a fleet, a bare to:['*'] is auto-scoped to your fleet (@fleet:<slug>, leader included) so routine status doesn't flood every agent — the result reports the rewrite as `scopedBroadcast`. Set allHive:true to keep '*' literal and reach EVERY agent, for system-wide issues / urgent notices only. No effect for a non-fleeted sender or a directed send.",
                            "type": "boolean"
                          },
                          "asAuthority": {
                            "description": "Renounce your fleet-control authority for THIS message — it is delivered UNSTAMPED, as an ordinary agent. A fleet LEADER needs this to send a hive-wide NOTICE (to:['*'] + allHive:true), which is otherwise refused as fleet_scoped_cue_allhive_contradiction: a leader may INFORM the hive, never COMMAND it. Do NOT use it to push a fleet-control cue (drain/pause/steer) past that guard. No effect for a sender holding no fleet-leader authority.",
                            "type": "string",
                            "const": "none"
                          },
                          "report": {
                            "$ref": "#/$defs/0"
                          },
                          "expectEffect": {
                            "$ref": "#/$defs/2"
                          },
                          "fieldProvenance": {
                            "$ref": "#/$defs/8"
                          }
                        },
                        "required": [
                          "to",
                          "summary",
                          "expects"
                        ],
                        "additionalProperties": false
                      }
                    }
                  },
                  "additionalProperties": false,
                  "x-papercusp-call-constraint": "When `items` is omitted, top-level `to`, `summary`, and `expects` are required; when `items` is used, each item must include its own `to`, `summary`, and `expects`.",
                  "$defs": {
                    "0": {
                      "description": "Structured status card (ReportBlock): { title?, plans:[{ title, status?, summary?, items?:[{ id?, text, status? }] }] }. Sent to [\"human\"] it renders as a 📋 card in the owner's Inbox (fleet updates, status digests) instead of plain text. Statuses like blocked/failing surface it as an Alert; a genuine decision still goes through coord:escalate. Invalid shape → loud report_invalid refusal (nothing sent).",
                      "type": "object",
                      "properties": {
                        "title": {
                          "type": "string"
                        },
                        "goalReport": {
                          "type": "object",
                          "properties": {
                            "schemaVersion": {
                              "type": "number",
                              "const": 1
                            },
                            "goalId": {
                              "type": "string"
                            },
                            "reportId": {
                              "type": "string"
                            },
                            "bodySha256": {
                              "type": "string"
                            }
                          },
                          "required": [
                            "schemaVersion",
                            "goalId",
                            "reportId",
                            "bodySha256"
                          ],
                          "additionalProperties": false
                        },
                        "plans": {
                          "type": "array",
                          "items": {
                            "type": "object",
                            "properties": {
                              "slug": {
                                "type": "string"
                              },
                              "title": {
                                "type": "string"
                              },
                              "status": {
                                "type": "string"
                              },
                              "summary": {
                                "type": "string"
                              },
                              "items": {
                                "type": "array",
                                "items": {
                                  "type": "object",
                                  "properties": {
                                    "id": {
                                      "type": "string"
                                    },
                                    "text": {
                                      "type": "string"
                                    },
                                    "status": {
                                      "type": "string"
                                    },
                                    "ref": {
                                      "type": "string"
                                    }
                                  },
                                  "additionalProperties": false
                                }
                              }
                            },
                            "additionalProperties": false
                          }
                        }
                      },
                      "required": [
                        "plans"
                      ],
                      "additionalProperties": false
                    },
                    "1": {
                      "type": "string",
                      "enum": [
                        "ack",
                        "answer",
                        "action",
                        "none"
                      ],
                      "description": "REQUIRED — what you want back from the recipient: 'ack' (confirm receipt) | 'answer' (reply with information) | 'action' (do something; a reply is optional) | 'none' (FYI/status, nothing expected). No default and no inference from `wake`: an FYI must say 'none' explicitly. Anything other than `none` marks the message unanswered-directed until the recipient threads a reply (related_msg_id), which drives leader-brief / fleet:assignments. A DIRECTED 'action'/'answer' ALSO requires `forYouBecause` on at least one body section (state why it is THEM); broadcasts and 'ack' are exempt."
                    },
                    "2": {
                      "description": "SAFETY-CRITICAL directives only: name the SIDE EFFECT the instruction requires — { kind:'checkpoint'|'claim-release'|'terminal', itemId } — and it is verified from the ledger afterwards instead of taken on the recipient's word. `queued:1` only proves a durable wake delivery was queued; it does not prove a session woke. Read the verdict on fleet:leader-brief (`directives`).",
                      "type": "object",
                      "properties": {
                        "kind": {
                          "type": "string",
                          "enum": [
                            "checkpoint",
                            "claim-release",
                            "terminal"
                          ]
                        },
                        "itemId": {
                          "type": "string",
                          "minLength": 1
                        },
                        "harness": {
                          "type": "string"
                        }
                      },
                      "required": [
                        "kind",
                        "itemId"
                      ],
                      "additionalProperties": false
                    },
                    "3": {
                      "description": "Wake sleeping addressees. Omit/false = inject only; true = 'required'. 'required' reports recipient_absent:true on a clean miss. Use 'optimistic' only with a verified durable retry named in `backstop`; without it, misses also report recipient_absent and fresh sessionState. Prefer 'required' or coord:handoff for one-off transfers. `queued` (legacy `woken`) counts durable wake delivery, never execution. Read `wakeOutcome` and `pickupConfirmed` separately: queued>0 is not pickup. Skips '*'/'human'.",
                      "anyOf": [
                        {
                          "type": "boolean"
                        },
                        {
                          "type": "string",
                          "enum": [
                            "required",
                            "optimistic"
                          ]
                        }
                      ]
                    },
                    "4": {
                      "description": "Declaring/referencing announced gate(s)? Pass the EXACT event key(s) (≤3 — e.g. the key events:emit { announce:true } RETURNED). The platform verifies each against the announced-gates store at send and stamps its status (declared/fired/undeclared); delivery renders the exact keys UN-CLIPPED, and receivers can skip copying entirely via events:await { fromMsg: <this msg_id> }. Kills hand-typed gate-key drift — a near-miss key never rendezvouses.",
                      "maxItems": 3,
                      "type": "array",
                      "items": {
                        "type": "string",
                        "minLength": 1
                      }
                    },
                    "5": {
                      "description": "WI-5445: which shared Hive `scope:'hive'` means, when this workspace hosts MORE THAN ONE shared Hive (mirrors resource:offers'/fleet:request_remote_spawn's own `hive` disambiguator — see the candidates list a bare scope:'hive' returns on ambiguous_hive_scope). Validated against the workspace's actual shared-hive set — an unknown name refuses loudly. No effect on a zero/single-shared-hive workspace or a harness-scoped (ctx) sender.",
                      "type": "string",
                      "minLength": 1
                    },
                    "6": {
                      "description": "ENVELOPE (one per message — one message serves one goal). WHY you are sending this, as a goal REF not prose (D-011), so the receiver can query the goal's LIVE state instead of trusting your snapshot of it. Shape: { goalRef: \"<goal ref>\", note?: \"<optional prose>\" }. `note` carries any prose.",
                      "type": "object",
                      "properties": {
                        "goalRef": {
                          "type": "string",
                          "minLength": 1
                        },
                        "note": {
                          "type": "string",
                          "minLength": 1
                        }
                      },
                      "required": [
                        "goalRef"
                      ],
                      "additionalProperties": false
                    },
                    "7": {
                      "description": "Per-message harness federation scope. In items:[…], this overrides the top-level `harness` default; in a single send it names the harness directly. A concrete harness-scoped session keeps its own ctx harness authoritative unless `scope:'local'` opts out.",
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 120
                    },
                    "8": {
                      "description": "Non-agent senders only (the operator GUI wrapper). Marks which fields were DERIVED rather than authored, so adoption measurement never counts them as sender intent.",
                      "type": "object",
                      "propertyNames": {
                        "type": "string"
                      },
                      "additionalProperties": {
                        "type": "string"
                      }
                    },
                    "9": {
                      "description": "Raise a coord:conditions alarm for this key. The persisted key is scoped to your authenticated sender, so a different producer cannot resolve it.",
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 512
                    },
                    "coord-send-body-v1": {
                      "description": "The message body: an ARRAY of sections. A plain string is REFUSED — the minimum is [{ text: \"...\" }]. Use SEVERAL sections when the parts of your message have different dispositions — a concession, an experimental result, an explicitly-undetermined claim — each with its own `premises` (an ARRAY OF REF STRINGS, e.g. `premises: [\"WI-1234#completion\"]`, not objects), `forYouBecause`, `youMayNotKnow`, `couldNotDetermine`. The `{ ref, provenance }` shape belongs in `youMayNotKnow`, not `premises`. `youMayNotKnow: [{ ref: \"WI-1234\", provenance: \"authored\" }]`, or `couldNotDetermine: [{ what: \"the thing you tried to establish\", note: \"optional detail\" }]`, `clarify`. The ENVELOPE fields (expects, blocking, why, basedOn) stay on the message and are refused on a section. LENGTH: a body over 600 characters (what one inbox read shows) is delivered in full as up to 12 ordered parts; only the final part carries `expects` and the wake. Longer is REFUSED: put it on `work_items:comment` or `coord:message-agent`, then send a short pointer.",
                      "x-papercusp-call-constraint": "body text joined with \"\\n\\n\" must fit 12 parts of <=600 characters",
                      "minItems": 1,
                      "maxItems": 20,
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "text": {
                            "type": "string",
                            "minLength": 1,
                            "description": "REQUIRED on every body section. A non-empty string containing what the recipient should read; structured fields such as `couldNotDetermine` or `blockedOn` add metadata but do not replace it."
                          },
                          "premises": {
                            "description": "PER-SECTION. What this section RESTS ON — claims someone ASSERTED (D-041). An ARRAY OF REF STRINGS (not objects — `forYouBecause` is the object one). Cite refs: The `{ ref, provenance }` shape belongs in `youMayNotKnow`, not `premises`. `fact:owner:<id>:<key>@v<N>` · `<plan-slug>#D-NNN` · `WI-NNNN#completion` (the completion CLAIM, not the item) · `msg:<msg_id>` · `owner-turn:<ref>` · `/internal/docs/...`. Any ref may be cited; the ref KIND decides whether it can go stale (a doc is declarable, never invalidatable). Distinct from `basedOn`, which is what you READ and is auto-derived.",
                            "maxItems": 20,
                            "type": "array",
                            "items": {
                              "type": "string",
                              "minLength": 1
                            }
                          },
                          "forYouBecause": {
                            "description": "PER-SECTION. Why THIS recipient is being told, STRUCTURED so it can be diffed against the computed coupling graph (a prose string cannot be). relation: holds-a-lock-on | owns | is-blocked-on | awaits | same-fleet | other. `note` is REQUIRED with 'other' (the non-structural escape hatch), and 'other' is excluded from the divergence check.",
                            "type": "object",
                            "properties": {
                              "relation": {
                                "type": "string",
                                "enum": [
                                  "holds-a-lock-on",
                                  "owns",
                                  "is-blocked-on",
                                  "awaits",
                                  "same-fleet",
                                  "other"
                                ]
                              },
                              "ref": {
                                "type": "string",
                                "minLength": 1
                              },
                              "note": {
                                "type": "string",
                                "minLength": 1
                              }
                            },
                            "required": [
                              "relation"
                            ],
                            "additionalProperties": false
                          },
                          "youMayNotKnow": {
                            "description": "PER-SECTION. Information I have that you may lack, as an ARRAY of { ref, provenance } OBJECTS — e.g. [{ ref: \"WI-1234\", provenance: \"authored\" }]. A bare string is REFUSED. 'computed' entries are the evidence-minus-your-watermark diff; 'authored' entries are my model of you and are valuable precisely because they can be WRONG. Label a GUESS `authored`, never `computed` — `computed` claims the diff produced it and is refutable against the recipient's read watermark; `authored` is never checked, so guessing costs you nothing. Not the same field as `couldNotDetermine` (D-024) — this one is a gap in YOUR knowledge, that one is a failed attempt of MINE.",
                            "maxItems": 20,
                            "type": "array",
                            "items": {
                              "type": "object",
                              "properties": {
                                "ref": {
                                  "type": "string",
                                  "minLength": 1
                                },
                                "provenance": {
                                  "type": "string",
                                  "enum": [
                                    "computed",
                                    "authored"
                                  ]
                                }
                              },
                              "required": [
                                "ref",
                                "provenance"
                              ],
                              "additionalProperties": false
                            }
                          },
                          "couldNotDetermine": {
                            "description": "PER-SECTION, AUTHORED ONLY. What I TRIED to establish and FAILED to — so you read the question as OPEN rather than answered, as an ARRAY of { what, note? } OBJECTS — e.g. [{ what: \"whether the next candidate carries the fix\" }]. A bare string is REFUSED. No system can derive this; if you do not write it, the receiver cannot distinguish \"unknown\" from \"not asked\".",
                            "maxItems": 20,
                            "type": "array",
                            "items": {
                              "type": "object",
                              "properties": {
                                "what": {
                                  "type": "string",
                                  "minLength": 1
                                },
                                "note": {
                                  "type": "string",
                                  "minLength": 1
                                }
                              },
                              "required": [
                                "what"
                              ],
                              "additionalProperties": false
                            }
                          },
                          "clarify": {
                            "description": "PER-SECTION. A question you need answered, PAIRED with the assumption you are proceeding on meanwhile: { question, assuming }. NON-BLOCKING by construction — you do not wait, and the answer CORRECTS you rather than unblocking you. `assuming` is REQUIRED: if you cannot name the fallback you will act on regardless, you have not identified a decision worth a peer's turn. Ask only what a QUERY cannot answer (locks:list, fleet:assignments, work_items:get) and where being wrong is expensive or irreversible. Descriptive only — never dispatched on.",
                            "maxItems": 10,
                            "type": "array",
                            "items": {
                              "type": "object",
                              "properties": {
                                "question": {
                                  "type": "string",
                                  "minLength": 1
                                },
                                "assuming": {
                                  "type": "string",
                                  "minLength": 1
                                }
                              },
                              "required": [
                                "question",
                                "assuming"
                              ],
                              "additionalProperties": false
                            }
                          },
                          "blockedOn": {
                            "description": "PER-SECTION. What this section is WAITING ON, structured so the reader can act on it — check it, diff it against live state, or events:await its clearing — rather than re-derive it from prose. kind: process | event | work-item | agent | owner | other. `ref` is REQUIRED for event (the events:catalog key) | work-item (WI-/EI-/F- id — a reader can await `work-item:done:<id>`) | agent (ownerId) | owner (the needs-human/escalation id). For kind:'process' give `taskId` (processes:list / logs:read can then check it) and/or `logPath` — a process blocker with neither is unactionable and refused. `note` is REQUIRED with 'other' (the escape hatch for a genuinely un-referenceable blocker; excluded from the staleness diff). `startedAt` (ISO-8601) lets the reader age the block without asking.",
                            "type": "object",
                            "properties": {
                              "kind": {
                                "type": "string",
                                "enum": [
                                  "process",
                                  "event",
                                  "work-item",
                                  "agent",
                                  "owner",
                                  "other"
                                ]
                              },
                              "ref": {
                                "type": "string",
                                "minLength": 1
                              },
                              "taskId": {
                                "type": "string",
                                "minLength": 1
                              },
                              "logPath": {
                                "type": "string",
                                "minLength": 1
                              },
                              "startedAt": {
                                "type": "string",
                                "minLength": 1
                              },
                              "note": {
                                "type": "string",
                                "minLength": 1
                              }
                            },
                            "required": [
                              "kind"
                            ],
                            "additionalProperties": false
                          }
                        },
                        "required": [
                          "text"
                        ],
                        "additionalProperties": false
                      }
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
              },
              {
                "name": "coord:dispatch",
                "description": "One call assigns either plan items (`items`) or concrete promoted work-items (`workItemIds`) to `to`, delivers `note`, and issues a required wake. The work-item path re-checks canonical blockers and assigns/wakes only the current actionable frontier; blocked descendants stay unassigned. Dead/absent/unwakeable targets return `ok:false` plus structured `failure` while durable assignment remains recoverable. Queueing is not proof a turn executed.",
                "inputSchema": {
                  "type": "object",
                  "properties": {
                    "to": {
                      "type": "string",
                      "minLength": 1,
                      "description": "The target agent — its ownerId or the short handle from [coord+N]/coord:presence. Single-target only (never \"*\")."
                    },
                    "note": {
                      "type": "string",
                      "minLength": 1,
                      "description": "The directed instruction the target reads in its inbox on waking — what to pick up and do. Name the plan + items explicitly. coord:send delivers over-cap text as ordered inbox-sized parts and keeps the required wake on the final part."
                    },
                    "planSlug": {
                      "description": "Plan slug whose items form the lane to assign (with `items`).",
                      "type": "string",
                      "maxLength": 120
                    },
                    "items": {
                      "description": "Plan-item ids (P-NNN) to push-assign to `to` as its durable lane. Omit for a pure directed wake.",
                      "maxItems": 40,
                      "type": "array",
                      "items": {
                        "type": "string",
                        "maxLength": 20
                      }
                    },
                    "workItemIds": {
                      "description": "Concrete promoted work-item ids to assign to the stable target. Re-read through canonical readiness; only actionable ids are claimed and included in the required wake. Mutually exclusive with `items`.",
                      "minItems": 1,
                      "maxItems": 200,
                      "type": "array",
                      "items": {
                        "$ref": "#/$defs/0"
                      }
                    },
                    "body": {
                      "description": "Optional body for the inbox note. coord:send delivers over-cap text as ordered inbox-sized parts; content beyond its chunk limit is refused with a durable-surface pointer.",
                      "type": "string",
                      "minLength": 1
                    },
                    "harness": {
                      "description": "Harness scope for the lane assignment (default: the plan's harness).",
                      "type": "string",
                      "maxLength": 120
                    },
                    "resumeAdmission": {
                      "description": "Resume one exact existing work item through its active durable admission promoter, then assignment/wake. Requires harness and one workItemId. No replacement item is created; queued never means picked up.",
                      "type": "boolean"
                    },
                    "pilotBinding": {
                      "description": "directed-pair pilot only: link the delivered role/session to a canonical binding receipt",
                      "type": "object",
                      "properties": {
                        "itemId": {
                          "$ref": "#/$defs/0"
                        },
                        "bindingReceiptId": {
                          "$ref": "#/$defs/0"
                        }
                      },
                      "required": [
                        "itemId",
                        "bindingReceiptId"
                      ],
                      "additionalProperties": false
                    }
                  },
                  "required": [
                    "to",
                    "note"
                  ],
                  "additionalProperties": false,
                  "$defs": {
                    "0": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 120
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
                "name": "improvements:capture",
                "description": "Capture a papercusp bug, improvement, feature, or observation as a durable work-unit. kind=bug is auto-implement eligible; change/feature are agent-reviewed. Dedup matches are annotated on the created row; only checkDuplicatesOnly skips persistence. lane:\"observation\" stays outside the work queue.",
                "inputSchema": {
                  "type": "object",
                  "properties": {
                    "title": {
                      "description": "one-line summary — REQUIRED unless body or toolFailure is supplied (body-only captures derive the title from the first non-empty body line; toolFailure derives bounded title/body server-side). TITLE IS AN IDENTIFIER, NOT A SENTENCE — lead with the stable SUBJECT (tool/verb name, surface, file path, error class), then the symptom in the plainest words you would use again; the narrative goes in the body, where it costs nothing. Recurrence and dedup match on the title's word-bag, so a title phrased as a reflection can never collide with a peer filing the SAME friction, and the recurring-condition escalation never fires. Do NOT include a [kind] prefix — pass kind separately.",
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 1000
                    },
                    "kind": {
                      "description": "bug = something broken (auto-eligible); change = a desired improvement; feature = net-new (both human-gated). Required for an improvement; ignored for lane:observation (always stored as a non-bug nit). Default change.",
                      "type": "string",
                      "enum": [
                        "bug",
                        "change",
                        "feature"
                      ]
                    },
                    "body": {
                      "description": "repro / context / the correct-state, especially for a bug",
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 16000
                    },
                    "severity": {
                      "type": "string",
                      "enum": [
                        "critical",
                        "major",
                        "minor",
                        "nit"
                      ]
                    },
                    "subTopic": {
                      "description": "optional sub-area topic, e.g. coord-dx, db-tooling",
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 40
                    },
                    "scope": {
                      "description": "Pot scope. OMIT (recommended) → the item files under the workspace platform Pot; pass 'harness:<slug>' to scope it to a specific Pot. (An omitted/'operator'/workspace-global scope auto-homes to the platform Pot — you do NOT need to pass 'harness:papercusp' by hand.)",
                      "type": "string",
                      "maxLength": 80
                    },
                    "harness": {
                      "description": "Compatibility alias for the common per-call harness spelling. `harness:'foo'` is normalized to `scope:'harness:foo'`; prefer `scope:'harness:foo'` for new calls.",
                      "type": "string",
                      "maxLength": 80
                    },
                    "foundDuring": {
                      "description": "what you were doing when you found this (a plan slug, a task, \"the X audit\"). Free text — truncated to 120 chars with a warning if longer, never rejected.",
                      "type": "string"
                    },
                    "paths": {
                      "description": "repo-relative file paths the improvement touches, when known — feeds the protected-path gate",
                      "maxItems": 20,
                      "type": "array",
                      "items": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 300
                      }
                    },
                    "observedRuntime": {
                      "description": "explicit runtime provenance for the environment that produced the report. Caller-only form: provide sha plus optional version/endpoint/evidenceRef and omit testRunIds and query fields. Trusted test-run form: provide testRunIds plus every query field (workspaceId, harnessSlug, runGroupId, root, filePaths), all non-empty; only matching clean server-owned ledger rows can validate the target SHA. This is separate from the runtime that received this capture call.",
                      "type": "object",
                      "properties": {
                        "sha": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 160,
                          "description": "runtime/source commit SHA explicitly observed by the caller"
                        },
                        "version": {
                          "description": "runtime version reported by the observed target",
                          "type": "string",
                          "maxLength": 160
                        },
                        "endpoint": {
                          "description": "endpoint used to exercise the observed target runtime",
                          "type": "string",
                          "maxLength": 500
                        },
                        "evidenceRef": {
                          "description": "durable evidence reference for the observed runtime",
                          "type": "string",
                          "maxLength": 500
                        },
                        "testRunIds": {
                          "description": "OPTIONAL for caller-only runtime evidence; REQUIRED when any provenance query field is supplied. When supplied, all query fields must also be non-empty.",
                          "maxItems": 64,
                          "type": "array",
                          "items": {
                            "type": "integer",
                            "exclusiveMinimum": 0,
                            "maximum": 9007199254740991
                          }
                        },
                        "workspaceId": {
                          "$ref": "#/$defs/1"
                        },
                        "harnessSlug": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 120
                        },
                        "runGroupId": {
                          "$ref": "#/$defs/2"
                        },
                        "root": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 1000
                        },
                        "filePaths": {
                          "maxItems": 20,
                          "type": "array",
                          "items": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 300
                          }
                        }
                      },
                      "required": [
                        "sha"
                      ],
                      "additionalProperties": false
                    },
                    "notifyAgents": {
                      "description": "@-mention SPECIFIC agents: ownerId prefixes / handles (resolve via coord:presence). Each is SUBSCRIBED to the captured item (gets every future update) AND pinged now, pointing at it — a DIRECTED handoff to a known owner. Distinct from the auto-topic broadcast (which reaches whoever subscribed to the area) and from claiming. Ignored for lane:observation. Use when you know exactly who should see/own this.",
                      "maxItems": 8,
                      "type": "array",
                      "items": {
                        "type": "string",
                        "minLength": 1
                      }
                    },
                    "force": {
                      "description": "suppress the duplicate verdict annotation when you have direct evidence this filing is distinct (default false)",
                      "type": "boolean"
                    },
                    "checkDuplicatesOnly": {
                      "description": "SEARCH ONLY, creates nothing: \"has anyone already hit this?\" — for improvement-lane captures. `lane:\"observation\"` skips duplicate search; its empty `possibleDuplicates` is not a verdict (read dedupCoverage/hint). Pass the symptom in title and the exact body before relying on results.",
                      "type": "boolean"
                    },
                    "assign_to": {
                      "description": "Atomically CLAIM the filed item in this same capture — an ownerId, or \"self\". Use when you are ALREADY working the thing you are filing: an unclaimed item goes to the claimable pool, where a peer may duplicate your in-progress fix. Omit ⇒ unclaimed. Ignored for observations. Fresh change/feature filings that enter agent review release the filer claim before the response and remain unassigned until review completes.",
                      "type": "string",
                      "maxLength": 120
                    },
                    "origin": {
                      "description": "signal provenance (frontier P-002) — default organic. ONLY a frontier loop passes non-organic (vaccination drill, replay counterfactual, shadow ablation); synthetic rows stay out of organic learners",
                      "type": "string",
                      "enum": [
                        "organic",
                        "drill",
                        "replay",
                        "shadow"
                      ]
                    },
                    "signalOrigin": {
                      "description": "compatibility alias for origin; the persisted/domain model calls this signalOrigin. Prefer origin for new calls. Do not pass both with different values.",
                      "type": "string",
                      "enum": [
                        "organic",
                        "drill",
                        "replay",
                        "shadow"
                      ]
                    },
                    "lane": {
                      "description": "'observation' files a PRE-IDEA turn-end reflection into the SEPARATE observation lane (D-005) — it never enters the work queue/triage/auto-implement; only Blender's corpus-digest + the Observations pane read it. Default 'improvement'.",
                      "type": "string",
                      "enum": [
                        "improvement",
                        "observation"
                      ]
                    },
                    "conditionKey": {
                      "description": "Stable recurring identity. Filing a condition you expect to see again — or are seeing again right now? Pass a stable `conditionKey` and MINT IT YOURSELF as `<area>:<stable-subject>` (e.g. `coord-send:ended-launcher-session`); it does not have to be a machine-issued key. This is the DESIGNED recurrence path: a still-open observation carrying the same key is updated in place with `repeatCount` bumped, rather than minting a row nothing can cluster. For an observation, a still-OPEN prior observation carrying the SAME conditionKey has its repeatCount bumped and its title/body refreshed instead of minting a fresh row. For an ordinary improvement/bug capture, the key feeds the exact-key coalescer so repeated filings refresh one open row even when lexical or semantic search is unavailable. Where a key is ALREADY published — an OverwatchBrief anomaly line's `[conditionKey: overwatch:escalation-aging]` — copy that one verbatim rather than minting a variant that cannot join it. Omit for a genuinely novel/one-off reading, which re-files as before. A rubric-graded scorecard (observation.rubricRef) DEFAULTS to `scorecard:<rubricRef>:<sourceHive>` when you omit this (EI-19325151590626958) — pass it explicitly to override.",
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 160
                    },
                    "toolFailure": {
                      "description": "Suspected tool-call failure. A one-off is captured immediately in non-claimable probation and correlated by tool/error/schema/field/runtime; a second independent reporter or the invocation watchdog promotes the SAME row. Put legacy direct-evidence flags inside this object — toolFailure.reproduced, toolFailure.clearServerMismatch, or toolFailure.hardInternal — and do not pass them at the top level. For a caller-class refusal, those booleans alone stay in probation: pass toolFailure.directEvidence { kind, expected, actual } only when you can state the inspectable contract mismatch that makes it a tool defect.",
                      "type": "object",
                      "properties": {
                        "toolName": {
                          "$ref": "#/$defs/1"
                        },
                        "errorCode": {
                          "$ref": "#/$defs/3"
                        },
                        "status": {
                          "type": "string",
                          "maxLength": 80
                        },
                        "message": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 4000
                        },
                        "schemaRevision": {
                          "$ref": "#/$defs/3"
                        },
                        "fieldPath": {
                          "type": "string",
                          "maxLength": 300
                        },
                        "runtimeVersion": {
                          "$ref": "#/$defs/3"
                        },
                        "reproduced": {
                          "type": "boolean"
                        },
                        "clearServerMismatch": {
                          "type": "boolean"
                        },
                        "hardInternal": {
                          "type": "boolean"
                        },
                        "directEvidence": {
                          "type": "object",
                          "properties": {
                            "kind": {
                              "type": "string",
                              "enum": [
                                "valid-input-reproduction",
                                "server-contract-mismatch",
                                "hard-internal"
                              ]
                            },
                            "expected": {
                              "$ref": "#/$defs/0"
                            },
                            "actual": {
                              "$ref": "#/$defs/0"
                            }
                          },
                          "required": [
                            "kind",
                            "expected",
                            "actual"
                          ],
                          "additionalProperties": false
                        }
                      },
                      "required": [
                        "toolName",
                        "message"
                      ],
                      "additionalProperties": false
                    },
                    "reproduction": {
                      "description": "A bug you ENCOUNTERED (D-024): ref = test_runs:<id> / tool_invocations:<id> (checked) or the log line, buildSha = the build it failed on. Verified, it skips bulk-review reproduction.",
                      "type": "object",
                      "properties": {
                        "ref": {
                          "$ref": "#/$defs/0"
                        },
                        "buildSha": {
                          "type": "string",
                          "minLength": 7,
                          "maxLength": 40
                        },
                        "kind": {
                          "type": "string",
                          "enum": [
                            "failing-test",
                            "scripted-repro",
                            "current-build-observation",
                            "encounter"
                          ]
                        }
                      },
                      "required": [
                        "ref",
                        "buildSha"
                      ],
                      "additionalProperties": false
                    },
                    "reportContext": {
                      "type": "object",
                      "properties": {
                        "appVersion": {
                          "$ref": "#/$defs/4"
                        },
                        "recentErrors": {
                          "maxItems": 10,
                          "type": "array",
                          "items": {
                            "type": "object",
                            "properties": {
                              "message": {
                                "$ref": "#/$defs/0"
                              },
                              "source": {
                                "$ref": "#/$defs/4"
                              }
                            },
                            "required": [
                              "message"
                            ],
                            "additionalProperties": false
                          }
                        }
                      },
                      "required": [
                        "recentErrors"
                      ],
                      "additionalProperties": false
                    },
                    "rubricRef": {
                      "description": "compatibility alias for observation.rubricRef; prefer observation:{ rubricRef, ratings }. CONDITIONAL: when observation.notExercised is non-empty, provide observation.rubricRef or the top-level rubricRef compatibility alias; omit it for a free-text observation.",
                      "type": "string",
                      "maxLength": 120
                    },
                    "ratings": {
                      "description": "compatibility alias for observation.ratings; prefer observation:{ rubricRef, ratings }",
                      "$ref": "#/$defs/observation-ratings-v1"
                    },
                    "observation": {
                      "description": "structured fields for a lane:observation record. Free-text observation evidence belongs in the top-level body; observation.evidence is not a valid field. For a rubric scorecard, put evidence in each observation.ratings[criterion].evidence. The observation object accepts structured fields only; observation.body is not a valid field, and prose belongs in the top-level body. The IDENTIFYING \"what\" is the title (see its rule — an observation is found again only by its title) and the whole narrative \"why\" is the body, which is unbounded free prose and the right home for the story. Pass rubricRef+ratings (each {rating,evidence}) to file a RUBRIC-GRADED observation — check rubrics:list first to see if a rubric fits.",
                      "type": "object",
                      "properties": {
                        "kind": {
                          "type": "string",
                          "enum": [
                            "friction",
                            "workaround",
                            "gap",
                            "surprise",
                            "reinforce",
                            "test-failure"
                          ]
                        },
                        "scope": {
                          "type": "string",
                          "enum": [
                            "self",
                            "role",
                            "harness",
                            "papercusp"
                          ]
                        },
                        "confidence": {
                          "description": "Evidence strength for this observation: low, med, or high. Do not use the fact-registry confidence labels verified/provisional/suspected; those belong to facts:assert.",
                          "type": "string",
                          "enum": [
                            "low",
                            "med",
                            "high"
                          ]
                        },
                        "refs": {
                          "description": "attribution: tool:/file:/WI- refs grounding the observation",
                          "maxItems": 12,
                          "type": "array",
                          "items": {
                            "$ref": "#/$defs/4"
                          }
                        },
                        "sourceHive": {
                          "description": "the pot the observation came FROM — AUTO-DERIVED from ctx (the agent harness/pot) when omitted; explicit callers (Overwatch/Blender) may set it",
                          "type": "string",
                          "maxLength": 120
                        },
                        "targetHive": {
                          "description": "optional: the pot the observation is ABOUT (a cross-pot observation)",
                          "type": "string",
                          "maxLength": 120
                        },
                        "rubricRef": {
                          "description": "a rubrics.rubric_id this observation grades against (e.g. 'pot-coordination-health'). Present ⇒ a rubric-graded observation; ratings must accompany it. CONDITIONAL: when observation.notExercised is non-empty, provide this field or the top-level rubricRef compatibility alias; omit it for a free-text observation.",
                          "type": "string",
                          "maxLength": 120
                        },
                        "ratings": {
                          "description": "per-criterion ratings against rubricRef, KEYED by rubric criterion `key` (a scorecard: one rating per criterion). evidence is mandatory on every entry",
                          "$ref": "#/$defs/observation-ratings-v1"
                        },
                        "notExercised": {
                          "description": "criterion keys this run did NOT exercise — each expands to { rating:'unknown', evidence:'idle: not exercised by this run.' } so a scoped drill passes the completeness gate without hand-written boilerplate (explicit ratings win). CONDITIONAL: when observation.notExercised is non-empty, provide observation.rubricRef or the top-level rubricRef compatibility alias; omit it for a free-text observation.",
                          "maxItems": 64,
                          "type": "array",
                          "items": {
                            "type": "string",
                            "minLength": 1
                          }
                        },
                        "linkTo": {
                          "description": "link this filing to one or more existing work-items at file time (e.g. a GRADE follow-up, or rel:'revises' for a feedback-driven revision) — best-effort, never fails the capture",
                          "maxItems": 5,
                          "type": "array",
                          "items": {
                            "type": "object",
                            "properties": {
                              "targetId": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 120,
                                "description": "the work-item id (WI-/F-/EI-…) this scorecard relates to"
                              },
                              "rel": {
                                "description": "default 'relates'; use 'revises' when this new filing incorporates feedback on the target",
                                "type": "string",
                                "enum": [
                                  "relates",
                                  "blocks",
                                  "duplicates",
                                  "fixes",
                                  "revises"
                                ]
                              },
                              "targetHarness": {
                                "description": "harness for a feature targetId (disambiguation)",
                                "type": "string",
                                "maxLength": 80
                              }
                            },
                            "required": [
                              "targetId"
                            ],
                            "additionalProperties": false
                          }
                        },
                        "subject": {
                          "description": "WHAT this scorecard grades (a per-RUN rubric needs this to be attributable/re-runnable): { ref, kind?, windowStart?, windowEnd? } — the replication-drill parameter binding. Omit for a pot-level or free-text observation.",
                          "type": "object",
                          "properties": {
                            "kind": {
                              "description": "what `ref` names; omit if you did not classify it",
                              "type": "string",
                              "enum": [
                                "agent-run",
                                "session",
                                "work-item",
                                "plan",
                                "pot"
                              ]
                            },
                            "ref": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 200,
                              "description": "the graded thing's id — the drills' `:subject` (an ownerId for an agent-run, a session id, a WI-/EI- id, a plan slug, a pot slug)"
                            },
                            "windowStart": {
                              "description": "ISO — start of the graded window; the drills' `:run_start`",
                              "type": "string",
                              "maxLength": 40
                            },
                            "windowEnd": {
                              "description": "ISO — end of the graded window; the drills' `:run_end`",
                              "type": "string",
                              "maxLength": 40
                            }
                          },
                          "required": [
                            "ref"
                          ],
                          "additionalProperties": false
                        }
                      },
                      "additionalProperties": false
                    },
                    "ideation": {
                      "description": "IDEATE-pass provenance for an su session's kind:'feature' origination — stamps the routed-idea ledger row (origin='su-ideate') with your declared lens so grade→outcome→feedback learning attributes back to it. Never a gate: purely additive, ignored for lane:observation / non-feature kinds.",
                      "type": "object",
                      "properties": {
                        "lens": {
                          "description": "the generative stance that produced this idea — Scout's four creative lenses (analogical / first-principles / reframing / constraint-removal) + the su stances (risk-first = de-risk the riskiest assumption; user-value = backward from felt owner/user value; cost-leverage = small change, big recurring cost). Declaring it earns per-lens outcome feedback on YOUR ideas (P-004); omitted = recorded under the 'su-ideate' sentinel (no per-lens learning)",
                          "type": "string",
                          "enum": [
                            "analogical",
                            "first-principles",
                            "reframing",
                            "constraint-removal",
                            "risk-first",
                            "user-value",
                            "cost-leverage"
                          ]
                        },
                        "bet": {
                          "description": "the bet — the concrete upside if the idea pans out (persisted to the created item payload, payload.ideation)",
                          "type": "string",
                          "maxLength": 2000
                        },
                        "addressesPatternRefs": {
                          "description": "the digest meta-pattern refs this idea GROUNDS ON — the observation→pattern→idea→shipped arc is joined on this field, so an idea filed without it can never show up as grounded in anyone's observationsImpact. You already have the refs: they come back from blender:ideation-feedback as observationsImpact.patterns[].ref (e.g. 'wi:EI-10587'). Pass the pattern(s) your pass actually built on",
                          "maxItems": 10,
                          "type": "array",
                          "items": {
                            "$ref": "#/$defs/2"
                          }
                        },
                        "cheapExperiment": {
                          "description": "the cheap falsifiable first experiment (ScoutExperiment shape, D-006 bettable-not-clever; persisted to payload.ideation — a COMPLETE one makes the idea machine-checkably bettable and ranks it first in triage)",
                          "type": "object",
                          "properties": {
                            "hypothesis": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 2000,
                              "description": "what we believe will be true if the idea has merit"
                            },
                            "method": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 2000,
                              "description": "the cheap first test (what to run / build / measure)"
                            },
                            "falsifiableSignal": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 2000,
                              "description": "the observable that would prove the hypothesis WRONG"
                            }
                          },
                          "required": [
                            "hypothesis",
                            "method",
                            "falsifiableSignal"
                          ],
                          "additionalProperties": false
                        }
                      },
                      "additionalProperties": false
                    }
                  },
                  "additionalProperties": false,
                  "x-papercusp-call-constraint": "at least one of title, body, or toolFailure is required; title is required when both body and toolFailure are omitted (body-only captures derive title from the first non-empty body line); a non-empty observation.notExercised requires observation.rubricRef or the top-level rubricRef compatibility alias (omit notExercised for free-text observations)",
                  "$defs": {
                    "0": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 2000
                    },
                    "1": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 160
                    },
                    "2": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 200
                    },
                    "3": {
                      "type": "string",
                      "maxLength": 160
                    },
                    "4": {
                      "type": "string",
                      "maxLength": 200
                    },
                    "observation-ratings-v1": {
                      "type": "object",
                      "propertyNames": {
                        "type": "string",
                        "minLength": 1
                      },
                      "additionalProperties": {
                        "type": "object",
                        "properties": {
                          "rating": {
                            "type": "string",
                            "minLength": 1,
                            "description": "a value from the criterion's ratingScale — default ['healthy','degraded','broken','unknown'] ('unknown' = not-assessable this wake)"
                          },
                          "evidence": {
                            "type": "string",
                            "minLength": 1,
                            "description": "MANDATORY concrete evidence backing the rating — a metric, a query result, a reference (a rating without evidence is rejected)"
                          },
                          "suggestion": {
                            "description": "OPTIONAL: your concrete improvement idea for this criterion — the Blender ideators see it as a seed",
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 2000
                          },
                          "remediation": {
                            "description": "REQUIRED (or `disregard`) on a POOR rating (fail/severe/broken/degraded/partial) of a standard rubric: the WI-/EI-/F- work-item this criterion's fix/investigation is tracked by, optionally with a short note (e.g. 'WI-1234 — watchdog class'). File/claim the item FIRST, then cite it — a poor grade that routes nowhere is rejected.",
                            "type": "string",
                            "minLength": 2,
                            "maxLength": 300
                          },
                          "disregard": {
                            "description": "the explicit alternative to `remediation` on a POOR rating: a reasoned, owned decision NOT to act (≥10 chars). Silence is rejected; 'n/a' is not a decision.",
                            "type": "string",
                            "minLength": 10,
                            "maxLength": 600
                          }
                        },
                        "required": [
                          "rating",
                          "evidence"
                        ],
                        "additionalProperties": false
                      }
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
                "name": "work_items:create",
                "description": "Create ONE or MANY work-items. bug/change/task file tracked issues; feature enters the harness queue; chunk is retired (rejected). If creation requests an assignment to a fleet MEMBER outside that member's claim scope, the finding is retained as an explicitly unassigned, claim-held filing with a visible downgrade — it never grants an out-of-scope claim. Single: { kind, title, … }; many: items:[…]. Returns per-item outcomes, including a visible warning when dedup coverage is degraded.",
                "inputSchema": {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "$ref": "#/$defs/8"
                    },
                    "title": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 1000
                    },
                    "summary": {
                      "description": "body / summary text",
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 8000
                    },
                    "body": {
                      "$ref": "#/$defs/9"
                    },
                    "harness": {
                      "description": "harness slug — required for feature; sets scope for bug/change. Also the DEFAULT harness for items that omit one.",
                      "type": "string",
                      "maxLength": 80
                    },
                    "pot": {
                      "$ref": "#/$defs/4"
                    },
                    "severity": {
                      "$ref": "#/$defs/d"
                    },
                    "parent": {
                      "description": "parent work-item id (historical feature-family compatibility)",
                      "type": "string",
                      "maxLength": 80
                    },
                    "topics": {
                      "$ref": "#/$defs/c"
                    },
                    "payload": {
                      "$ref": "#/$defs/b"
                    },
                    "routing_intent": {
                      "$ref": "#/$defs/7"
                    },
                    "cadence": {
                      "description": "explicit cadence for routing_intent=schedule-recurrence, e.g. \"daily at 09:00\" or a cron expression",
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 200
                    },
                    "urgent": {
                      "description": "URGENT enqueue: wake the brain immediately (floor-debounced). Reserve for a production fire, not routine filing.",
                      "type": "boolean"
                    },
                    "force": {
                      "description": "Override the dupe guards (EI-316 mirror, semantic cosine, exact identity).",
                      "type": "boolean"
                    },
                    "assign_to": {
                      "description": "Atomically CLAIM the new item for this agent id in the SAME create (B-LOOP-4) — pass a concrete ownerId, or the literal \"self\" to resolve to the caller. Omit ⇒ unclaimed.",
                      "type": "string",
                      "maxLength": 120
                    },
                    "changeKinds": {
                      "$ref": "#/$defs/1"
                    },
                    "changeKindReason": {
                      "$ref": "#/$defs/a"
                    },
                    "state": {
                      "$ref": "#/$defs/2"
                    },
                    "plan_item": {
                      "$ref": "#/$defs/0"
                    },
                    "links": {
                      "$ref": "#/$defs/5"
                    },
                    "conditionKey": {
                      "$ref": "#/$defs/6"
                    },
                    "directiveRef": {
                      "$ref": "#/$defs/3"
                    },
                    "items": {
                      "description": "create many work-items at once — each is a full create spec.",
                      "minItems": 1,
                      "maxItems": 100,
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "kind": {
                            "$ref": "#/$defs/8"
                          },
                          "title": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 1000
                          },
                          "summary": {
                            "description": "body / summary text",
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 8000
                          },
                          "body": {
                            "$ref": "#/$defs/9"
                          },
                          "harness": {
                            "description": "harness slug — required for feature/chunk; sets scope for bug/change. Falls back to the batch `harness` default.",
                            "type": "string",
                            "maxLength": 80
                          },
                          "pot": {
                            "$ref": "#/$defs/4"
                          },
                          "severity": {
                            "$ref": "#/$defs/d"
                          },
                          "parent": {
                            "description": "parent work-item id (feature-family; required-shape for a chunk)",
                            "type": "string",
                            "maxLength": 80
                          },
                          "topics": {
                            "$ref": "#/$defs/c"
                          },
                          "payload": {
                            "$ref": "#/$defs/b"
                          },
                          "routing_intent": {
                            "$ref": "#/$defs/7"
                          },
                          "cadence": {
                            "description": "explicit cadence for routing_intent=schedule-recurrence, e.g. \"daily at 09:00\" or a cron expression",
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 200
                          },
                          "urgent": {
                            "description": "URGENT enqueue: wake the brain immediately (floor-debounced). Reserve for a production fire.",
                            "type": "boolean"
                          },
                          "force": {
                            "description": "Override the dupe guards (EI-316 mirror, semantic cosine, exact identity) for this item.",
                            "type": "boolean"
                          },
                          "assign_to": {
                            "description": "Atomically CLAIM this item for this agent id in the SAME create (B-LOOP-4) — pass a concrete ownerId, or the literal \"self\" to resolve to the caller. Overrides assign_all_to_self for this item.",
                            "type": "string",
                            "maxLength": 120
                          },
                          "changeKinds": {
                            "$ref": "#/$defs/1"
                          },
                          "changeKindReason": {
                            "$ref": "#/$defs/a"
                          },
                          "state": {
                            "$ref": "#/$defs/2"
                          },
                          "plan_item": {
                            "$ref": "#/$defs/0"
                          },
                          "links": {
                            "$ref": "#/$defs/5"
                          },
                          "conditionKey": {
                            "$ref": "#/$defs/6"
                          },
                          "conditionReplay": {
                            "description": "For immutable revision identities: reuse the original conditionKey filing after closure too, without reopening or rewriting its disposition. Requires conditionKey and a concrete workspace. Omit for recurring alarms.",
                            "type": "string",
                            "const": "include-terminal"
                          },
                          "directiveRef": {
                            "$ref": "#/$defs/3"
                          }
                        },
                        "required": [
                          "kind",
                          "title"
                        ],
                        "additionalProperties": false
                      }
                    },
                    "assign_all_to_self": {
                      "description": "Claim every created item for YOU (your ownerId) — unless an item carries its own assign_to.",
                      "type": "boolean"
                    },
                    "workspace": {
                      "description": "target workspace id — defaults to the request workspace (MCP ?workspace=). EI-728 routing for the inline create / every item.",
                      "type": "string",
                      "maxLength": 120
                    },
                    "phone_producer": {
                      "description": "Admit a Phone voice producer from the configured authenticated host. Room selector only; host records supply identity and canonical binding. Exclusive with ordinary create metadata.",
                      "type": "object",
                      "properties": {
                        "roomName": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 200,
                          "pattern": "^[^\\u0000-\\u001f\\u007f]+$"
                        }
                      },
                      "required": [
                        "roomName"
                      ],
                      "additionalProperties": false
                    }
                  },
                  "additionalProperties": false,
                  "$defs": {
                    "0": {
                      "description": "Plan item this work-item IMPLEMENTS ({ slug, item:\"P-003\" }): writes a work→plan_item coverage edge so it rolls up into that item; completing the item can auto-resolve it as residue. A bug merely DISCOVERED while working an item is NOT implementing it — file it unlinked (EI-19460536530145188).",
                      "type": "object",
                      "properties": {
                        "slug": {
                          "type": "string",
                          "minLength": 1
                        },
                        "item": {
                          "type": "string",
                          "minLength": 1
                        }
                      },
                      "required": [
                        "slug",
                        "item"
                      ],
                      "additionalProperties": false
                    },
                    "1": {
                      "minItems": 1,
                      "maxItems": 10,
                      "type": "array",
                      "items": {
                        "type": "string",
                        "enum": [
                          "ui",
                          "service",
                          "migration",
                          "background-job",
                          "logic",
                          "refactor",
                          "docs",
                          "config",
                          "test-only",
                          "no-code-change"
                        ]
                      },
                      "description": "The kind(s) of change this work makes, from the bundled catalog: ui, service, migration, background-job, logic, refactor, docs, config, test-only, no-code-change. A successful close must carry each kind's proof. Re-declaring later keeps the earlier declaration in history."
                    },
                    "2": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 40,
                      "description": "initial lifecycle state (EI-10897) — e.g. 'wip' to open an ad-hoc unit you are starting RIGHT NOW (pair with assign_to:'self'). Defaults to the kind's normal entry state (todo). Terminal states and 'blocked' are rejected: complete the item instead, or create it then name its blocker with work_items:set_blocker."
                    },
                    "3": {
                      "description": "owner-directive provenance: the orders id this work-item is being created to carry out (harness_shared.owner_directives.id). Late-binding and one-directional — the directive is never written back. Omit for ordinary work; a directive with zero linked work-items is healthy, not degenerate.",
                      "type": "integer",
                      "exclusiveMinimum": 0,
                      "maximum": 9007199254740991
                    },
                    "4": {
                      "description": "Pot to scope this to (the pot home-harness slug). Omit in a harness-scoped session — it auto-resolves from your harness (a member harness resolves to its pot's home). A workspace-spanning caller (Mug/overwatch) that can't auto-resolve must pass an explicit pot.",
                      "type": "string",
                      "minLength": 1
                    },
                    "5": {
                      "description": "inline typed links (WI-3956) written from the new item to targets on create — e.g. [{ rel:\"investigates\", target_id:\"EI-9250\" }]. Best-effort: a bad target is skipped, never fails the create.",
                      "maxItems": 20,
                      "type": "array",
                      "items": {
                        "$ref": "#/$defs/work-items-create-link-v1"
                      }
                    },
                    "6": {
                      "description": "recurring-detector filing identity (WI-39604): an OPEN item already holding this key is refreshed and returned (see conditionUpsert on the result) instead of a sibling being filed — single-host system filers only.",
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 200
                    },
                    "7": {
                      "description": "explicit papercusp-way routing intent. Body/summary prose is never classified. schedule-recurrence also requires cadence.",
                      "type": "string",
                      "enum": [
                        "schedule-recurrence",
                        "watch-alert",
                        "credential-key",
                        "create-app",
                        "bring-repo-under-management",
                        "design-screen"
                      ]
                    },
                    "8": {
                      "description": "built-in kind (feature, bug, change, task); 'chunk' is deprecated (historical rows remain readable) OR a workspace-registered generic-kind datatype (declared via meta:define-datatype)",
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 80
                    },
                    "9": {
                      "description": "alias for `summary` — the item body text (work_items:update names it `body`). Pass either; both-with-different-values is rejected (WI-4492).",
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 8000
                    },
                    "work-items-create-link-v1": {
                      "type": "object",
                      "properties": {
                        "rel": {
                          "type": "string",
                          "enum": [
                            "blocks",
                            "relates",
                            "duplicates",
                            "fixes",
                            "about",
                            "investigates",
                            "caused-by",
                            "revises"
                          ],
                          "description": "the relationship: blocks | relates | duplicates | fixes | investigates | about | caused-by | revises"
                        },
                        "target_id": {
                          "description": "a target work-item id",
                          "type": "string",
                          "maxLength": 120
                        },
                        "target_kind": {
                          "description": "explicit coord ObjectRef kind (e.g. plan_item, event) — use with target_ref",
                          "type": "string",
                          "maxLength": 40
                        },
                        "target_ref": {
                          "description": "explicit coord ObjectRef ref — use with target_kind",
                          "type": "string",
                          "maxLength": 160
                        },
                        "target_harness": {
                          "description": "harness for a feature target_id (disambiguation)",
                          "type": "string",
                          "maxLength": 80
                        },
                        "satisfaction": {
                          "description": "blocks-only outcome requirement; omitted defaults to settled",
                          "type": "string",
                          "enum": [
                            "settled",
                            "success"
                          ]
                        }
                      },
                      "required": [
                        "rel"
                      ],
                      "additionalProperties": false
                    },
                    "a": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 1000,
                      "description": "Why the declared kinds changed or were first declared late. Stored with the declaration."
                    },
                    "b": {
                      "description": "kind-specific data (feature-family)",
                      "type": "object",
                      "propertyNames": {
                        "type": "string"
                      },
                      "additionalProperties": {}
                    },
                    "c": {
                      "description": "topic slugs to tag (topics:list)",
                      "maxItems": 8,
                      "type": "array",
                      "items": {
                        "type": "string",
                        "minLength": 1
                      }
                    },
                    "d": {
                      "description": "issue-family (bug/change) only",
                      "type": "string",
                      "enum": [
                        "critical",
                        "major",
                        "minor",
                        "nit"
                      ]
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
                "name": "work_items:get",
                "description": "Read work-items by ID (`id` for one; `ids` for a batch). Returns `{ ok, results:[…], counts }`; correlate rows by id, not position. Batch reads also include a per-requested-ID receipt. Read `returns` for conditional warnings.",
                "inputSchema": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "description": "a single work-item id (n=1 shorthand for ids:[id])",
                      "type": "string",
                      "minLength": 1
                    },
                    "attachments": {
                      "description": "Standalone one-item consented attachment read: {} lists metadata; id returns a base64 byte page (default 1024 bytes, max 2048). Canonical fixes resolve original report evidence. Expired evidence is unavailable.",
                      "type": "object",
                      "properties": {
                        "id": {
                          "type": "string",
                          "format": "uuid",
                          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
                        },
                        "offset": {
                          "type": "integer",
                          "minimum": 0,
                          "maximum": 9007199254740991
                        },
                        "limit": {
                          "type": "integer",
                          "minimum": 1,
                          "maximum": 2048
                        }
                      },
                      "additionalProperties": false
                    },
                    "ids": {
                      "description": "work-item ids for ordinary reads (1–100). With resume:true, provide one ID only; prefer the id argument for a continuation read.",
                      "maxItems": 100,
                      "type": "array",
                      "items": {
                        "type": "string",
                        "minLength": 1
                      }
                    },
                    "harness": {
                      "description": "caller harness scope; do not copy a cross-hive row's canonical harness here",
                      "type": "string",
                      "maxLength": 80
                    },
                    "detail": {
                      "description": "also return topics, thread posts (comments), outgoing links, `lifecycle` — the unified history (blocks, holds, reopens) with a coverage report saying what is NOT recorded — and `priorAttempts`, the bounded prior-attempt brief (what was already tried on this item's plan lane, and what the budget OMITTED). Accepts `true`/`false`, or the aliases `'full'`/`'summary'` (some tools in this catalog use that string-enum convention instead).",
                      "type": "boolean"
                    },
                    "checksOnly": {
                      "description": "return only the stored checkpoint check-row ledger (`checkpointChecks.rows` with caller-facing id/claim identities) plus recency/failure metadata; omit the checkpoint narrative and other enrichments. Use this before building `retireIds` instead of fetching the full checkpoint body.",
                      "type": "boolean"
                    },
                    "checkpointOnly": {
                      "description": "standalone exact checkpoint text page for exactly one item; skips item payload and other enrichments. Pair with root-level offset (Unicode code points, default 0) and limit (default 512, hard cap 768); follow checkpointPage.nextOffset and compare checkpointContentHash across pages. checkpointPage:null means no stored checkpoint unless checkpointReadFailed is true.",
                      "type": "boolean"
                    },
                    "offset": {
                      "description": "checkpointOnly page start measured in Unicode code points; omitted means 0. The returned checkpointPage.offset is clamped to totalChars.",
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 10000000
                    },
                    "limit": {
                      "description": "checkpointOnly page size in Unicode code points; omitted means 512. Larger requests are clamped to 768 and disclosed in checkpointPage.limitClamped.",
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 1000000
                    },
                    "resume": {
                      "description": "Standalone one-item continuation view: current claim, complete structured next action, saved checks and exact evidence references, with freshness and scoped recovery. Pass exactly one item (prefer id; a one-element ids array is accepted, but multi-id batches are rejected). Uses checkpoint:{did,left,next} written by work_items:checkpoint; missing/unreadable state remains explicit. Checks are at results[].resume.checks.rows (an array), not resume.checks; resume.checks.omitted counts saved rows excluded by the packet budget. Do not combine with detail, checksOnly, checkpointOnly, offset, limit, threadLimit, priorAttemptRefs, or operationalBrief; use a separate read for those enrichments.",
                      "type": "boolean"
                    },
                    "operationalBrief": {
                      "description": "Add `operationalBrief` per row: claim/state, blockers, last verified evidence, next action and successor residue, projected from this same read. Unmeasured fields are explicit `unknown` with a reason, never zero. Forces a complete read; not with resume or checksOnly.",
                      "type": "boolean"
                    },
                    "priorAttemptRefs": {
                      "description": "raw drill-down for the requested work-item(s): pass `id` (one) or `ids` (many) together with these refs. Resolve refs back to their FULL untruncated source records. When combined with `detail:true`, this replaces the bounded `priorAttempts` brief so the response does not mix clipped history with the raw records; make a separate read if you need both views. Take refs from a brief's `omission.omittedRefs` (records the budget could only COUNT) or from a clipped record's own `rawRef` — the brief names them precisely so a bounded read is never a dead end. Refs that no longer resolve come back in `unresolved[]`, which is an answer about the history, not an error.",
                      "maxItems": 20,
                      "type": "array",
                      "items": {
                        "type": "string",
                        "minLength": 1
                      }
                    },
                    "threadLimit": {
                      "description": "return a bounded oldest-first recent-comment window instead of loading the full thread; 0 explicitly suppresses thread work, positive values return up to 10 posts with a same-snapshot total. The effective window is capped at 10: a larger value is CLAMPED (not rejected) and the result reports `threadLimitClamped:{requested,applied}` — read `threadWindow.total`, not `shown`, for how many posts exist.",
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 100
                    }
                  },
                  "additionalProperties": false,
                  "x-papercusp-call-constraint": "resume requires one item (pass `id`, or a one-element `ids` array; multi-id batches are not supported) and cannot be combined with detail, checksOnly, checkpointOnly, offset, limit, threadLimit, priorAttemptRefs or operationalBrief; use a separate read for those enrichments (two calls: work_items:get { id, resume:true } for the continuation, then work_items:get { id, detail:true } for the detail record)"
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
                "name": "work_items:list",
                "description": "List work-items across kinds (feature/chunk/bug/change/task). Default shows top-level items (chunks are hidden — pass parent or includeChildren). Filter by harness, kind, state, or q (a case-insensitive literal substring over title, body/summary, and retained capture occurrence title/body). Returns the WorkItem array directly — each row's summary is EXCERPTED to keep the list bounded (a row carries summary_truncated + summary_full_chars when cut); use work_items:get { id } for a full body.",
                "inputSchema": {
                  "type": "object",
                  "properties": {
                    "prDeliveryAudit": {
                      "description": "Read-only PR-bypass audit of EVERY admission from explicit workflow ruleIds, including disabled rules and rules omitting delivery:pr. Returns {prDeliveryAudit}; missing evidence or truncated populations are unknown. Ordinary list filters do not narrow this audit.",
                      "type": "object",
                      "properties": {
                        "ruleIds": {
                          "minItems": 1,
                          "maxItems": 20,
                          "type": "array",
                          "items": {
                            "type": "string",
                            "format": "uuid",
                            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
                          }
                        }
                      },
                      "required": [
                        "ruleIds"
                      ],
                      "additionalProperties": false
                    },
                    "harness": {
                      "type": "string",
                      "maxLength": 80
                    },
                    "includeBody": {
                      "description": "Internal source projection override: omit issue body/summary when false.",
                      "type": "boolean"
                    },
                    "includePayload": {
                      "description": "Internal source projection override: omit JSONB payload when false.",
                      "type": "boolean"
                    },
                    "q": {
                      "description": "case-insensitive literal substring matched against title and body/summary",
                      "type": "string",
                      "maxLength": 200
                    },
                    "kind": {
                      "description": "built-in kind (feature, chunk, bug, change, task) OR a workspace-registered generic-kind datatype",
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 80
                    },
                    "state": {
                      "description": "WI-38339: ONE state, or an ARRAY of states (matches any of them). Alias: `states` (alias-group:state|states). An empty array is NO filter, never 'match nothing'. For the dominant question — everything still open — prefer `notTerminal`, which cannot drift as the terminal spellings change.",
                      "anyOf": [
                        {
                          "type": "string",
                          "maxLength": 40
                        },
                        {
                          "maxItems": 20,
                          "type": "array",
                          "items": {
                            "type": "string",
                            "maxLength": 40
                          }
                        }
                      ]
                    },
                    "states": {
                      "description": "Alias for the ARRAY form of `state` (alias-group:state|states) — matches any supplied state. Passing both names is rejected unless the caller uses only one spelling.",
                      "maxItems": 20,
                      "type": "array",
                      "items": {
                        "type": "string",
                        "maxLength": 40
                      }
                    },
                    "notTerminal": {
                      "description": "WI-38339: exclude every state terminal in EITHER family (done/passed/resolved/closed/deprecated/dropped), derived from the canonical union rather than a copied list. The 'everything not finished' filter agents otherwise hand-write as `status NOT IN (…)` in raw SQL.",
                      "type": "boolean"
                    },
                    "createdSince": {
                      "description": "ISO 8601 timestamp with timezone — rows created at or after it (INCLUSIVE, like plans:list).",
                      "type": "string",
                      "maxLength": 40,
                      "format": "date-time",
                      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
                    },
                    "updatedSince": {
                      "description": "ISO 8601 timestamp with timezone — rows updated at or after it (INCLUSIVE, like plans:list).",
                      "type": "string",
                      "maxLength": 40,
                      "format": "date-time",
                      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
                    },
                    "sourcePlanSlug": {
                      "description": "Persisted item provenance only: rows produced or stamped by this plan. It does NOT include ad-hoc work merely performed while a session/fleet declared that plan; scheduler `plan` predicates are item-provenance filters too. Alias: `plan` (alias-group:sourcePlanSlug|plan).",
                      "type": "string",
                      "maxLength": 120
                    },
                    "plan": {
                      "description": "Alias for `sourcePlanSlug` (alias-group:sourcePlanSlug|plan) — the SAME item-provenance filter. Passing both with different values is rejected.",
                      "type": "string",
                      "maxLength": 120
                    },
                    "assignee": {
                      "description": "Filter to items assigned to this agent (feature → taken_by; issue → assignee). The literal \"self\" resolves to YOU (as it does in work_items:claim / claim_next / create's assign_to); `mine: true` is the same request.",
                      "type": "string",
                      "maxLength": 120
                    },
                    "assignedBy": {
                      "description": "Filter issue-family items by the owner who delegated them (the durable `assigned_by` field). This filter is ignored for feature-family rows, which have no delegator column.",
                      "type": "string",
                      "maxLength": 120
                    },
                    "mine": {
                      "description": "Filter to items assigned to the CALLER (resolves your own agent identity) — EI-6506: a leader's 'see your work item' handoff, findable without raw PG or knowing your own ownerId string. Overridden by an explicit `assignee` if both are passed.",
                      "type": "boolean"
                    },
                    "parent": {
                      "description": "list children (chunks) of this parent id",
                      "type": "string",
                      "maxLength": 80
                    },
                    "includeChildren": {
                      "description": "include child items (chunks) in the list",
                      "type": "boolean"
                    },
                    "admissibleOnly": {
                      "description": "EI-7841/WI-3649: a cheap pre-filter, NOT the full claim-floor verdict. Feature-family: the G2 admission/trust gate (remote, un-admitted, untrusted-author) work_items:claim/claim_next enforce. Issue-family (bug/change/task): every ROW-INTRINSIC claim floor — remote origin, observation lane, replication-liveness detector, claim-hold, needs-human, reserved-plan-lane, loop-noise, already-terminally-completed, active external blocker (WI-4405/WI-37761/WI-37774). It does NOT apply the floors needing live claim context (blocked-dep / cooldown / rig / swarm-affinity / redundancy), so a row it admits may STILL be unclaimable — the origin+lane-only version caused the 2026-07-12 idle-fleet miss. ⚠ NOT the claimable verdict: for 'what issue-family work can I claim right now' use work_items:claimable (the full floors). Default false (full backlog incl. gated items, for overview/leader reads).",
                      "type": "boolean"
                    },
                    "audit": {
                      "description": "Integrity diagnostics: terminal rows, except worked-then-abandoned (nonterminal: claimed/worked/released >21d ago). DETECTOR, not verdict: read each row; never bulk-close. work_items:stranded instead examines checkpoints. No-evidence closes now land authority:proposed and stay owned. no-completion-record = missing completionRef and authority, usually legacy/system bypass; suspicious = local rows without recognized system closer, investigate write paths; federated = remote-origin awareness, not proof of a local bypass. geometry-unverified = layout file (*.css/*.tsx/*.jsx) with unit/absent verifiedHow; intermittent-underevidenced = flaky/racy title with only pass streaks, lacking failure rate/root cause/deterministic reproduction; reconciler-sourced = mirrors plan status without independent verification. Newest-first; composes with state.",
                      "type": "string",
                      "enum": [
                        "no-completion-record",
                        "no-completion-record-suspicious",
                        "no-completion-record-federated",
                        "geometry-unverified",
                        "intermittent-underevidenced",
                        "reconciler-sourced",
                        "claim-since-falsified",
                        "change-kind-mismatch",
                        "worked-then-abandoned"
                      ]
                    },
                    "completionAuthority": {
                      "description": "Filter TERMINAL rows by the completion-authority judgement the P-004 gate stamped: 'committed' (evidence sufficient — verifiedHow PLUS testsRun/testResult), 'proposed' (closed but under-evidenced: recorded, out of burn-down, still owned by its closer), 'validated'/'pending_human'/'invalid', or 'unjudged' for a close carrying NO judgement. This is how you LIST under-evidenced closes — the read D-012 left open when P-006/D-003 deleted the 'no-evidence' audit bucket. ⚠ 'unjudged' measures the INSTRUMENT, not the agents: only work_items:complete stamps an authority, so a close made via the bare state-write path lands NULL however well evidenced it was (that path records its evidence in terminalCompletionRef instead, and complete's structured evidence lands in payload._completionEvidence — three places, so no single field is a complete evidence test). Measured 2026-07-27: 38.2% of that day's agent closes were gate-judged vs 0.1% the day before, so an 'unjudged' hit means \"never judged\", NOT \"unevidenced\". Non-terminal rows never match. Composes with `state` and `audit`.",
                      "type": "string",
                      "enum": [
                        "proposed",
                        "validated",
                        "committed",
                        "pending_human",
                        "invalid",
                        "unjudged"
                      ]
                    },
                    "includeObservations": {
                      "description": "EI-10422: by default a payload.lane:'observation' row (a turn-end reflection / rubric scorecard filed via improvements:capture { lane:'observation' }) is EXCLUDED — by design (D-005) it never enters the work queue/triage. Pass true to include raw observations in this read (a curation surface); the default keeps the backlog/triage view free of the ~2,700 open notes that otherwise masquerade as claimable `change` work.",
                      "type": "boolean"
                    },
                    "natures": {
                      "description": "P-010/D-011: natures to return (work|record|document|event). Default: work only, unless kind is named. ['record'] reads record rows such as pipeline deals.",
                      "type": "array",
                      "items": {
                        "type": "string",
                        "enum": [
                          "work",
                          "record",
                          "document",
                          "event"
                        ]
                      }
                    },
                    "audience": {
                      "description": "D-041: 'agent' = only rows an agent may claim/close; 'human' = human-audience rows; 'any' = both. Default for agent callers: 'agent', unless kind or natures is named.",
                      "type": "string",
                      "enum": [
                        "agent",
                        "human",
                        "any"
                      ]
                    },
                    "limit": {
                      "type": "integer",
                      "exclusiveMinimum": 0,
                      "maximum": 500
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
                "name": "work_items:claimable",
                "description": "The authoritative issue-family \"claimable right now\" read — bug/change/task rows surviving the spec filter and all claim floors, using scheduler:get_next's oracle. Fleet scoping uses `spec:'<fleet-slug>'`; this tool has no `fleet` argument. READ-ONLY. `excludedSample.agentReview` samples ordinary-claim exclusions and can include `revision-requested` reviews; `excludedSample.queueControl.agentReview` lists pending reviewer candidates only. `queueControl` separates active claims, hold-open leases, durable parks; `sampleExcluded` adds provenance, age, and UNPARK details.",
                "inputSchema": {
                  "type": "object",
                  "properties": {
                    "harness": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 80,
                      "description": "the harness lane to read claimable issue-family work for"
                    },
                    "rigAvailable": {
                      "description": "WI-2796: pass true ONLY when you actually have/coordinate a live ≥2-machine or Hetzner federation rig. Default (false/omitted): items tagged payload.needs_2_machine_rig are excluded from this caller's claimable read.",
                      "type": "boolean"
                    },
                    "kind": {
                      "description": "restrict to these issue-family kind(s); default all of bug/change/task",
                      "anyOf": [
                        {
                          "$ref": "#/$defs/0"
                        },
                        {
                          "minItems": 1,
                          "type": "array",
                          "items": {
                            "$ref": "#/$defs/0"
                          }
                        }
                      ]
                    },
                    "spec": {
                      "description": "a fleet's claim-spec scoping the lane (its view.filter + states + rank ordering) — the FLEET SLUG, the spec's own `specId`, or a strict `revN` shorthand when that revision uniquely identifies one live fleet spec (ambiguous/unrecognized values error with candidates; they never silently widen to the whole backlog). Omit ⇒ the caller's effective per-bee/inherited fleet spec, or DEFAULT_CLAIM_SPEC for an unscoped caller.",
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 120
                    },
                    "states": {
                      "description": "claimable-status floor override (default: the spec's states, else ['todo']-family claimable states)",
                      "minItems": 1,
                      "type": "array",
                      "items": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 40
                      }
                    },
                    "limit": {
                      "description": "max claimable rows to return (default 20, cap 200)",
                      "type": "integer",
                      "exclusiveMinimum": 0,
                      "maximum": 200
                    },
                    "breakdownOnly": {
                      "description": "skip the row list — return only claimableCount + matchedByFilter + excludedBreakdown (cheaper)",
                      "type": "boolean"
                    },
                    "sampleExcluded": {
                      "description": "Valid values are 1 through 10 (maximum 10 ids per floor). Also return `excludedSample`: up to this many ids PER FLOOR (taken/claimHold/needsHuman/…, same overlapping-bucket semantics as excludedBreakdown) — the ROW-LEVEL diagnostic companion to the counts, answering \"which items\" instead of just \"how many\" without raw SQL. Omit to skip (cheaper — one extra bounded query per call when set).",
                      "type": "integer",
                      "exclusiveMinimum": 0,
                      "maximum": 10
                    }
                  },
                  "required": [
                    "harness"
                  ],
                  "additionalProperties": false,
                  "$defs": {
                    "0": {
                      "type": "string",
                      "enum": [
                        "bug",
                        "change",
                        "task",
                        "cleanup"
                      ]
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
                "name": "work_items:set_state",
                "description": "Set state for one or many work-items: open|wip|blocked|needs-human|done|dropped (legacy aliases preserve terminal_reason). Terminal writes need completionRef + assumptions (\"none\" or facts:assert keys). Blocked writes need work_items:set_blocker; use work_items:link { rel:\"blocks\" } for internal dependencies. Plan-linked features use plans:set-status. Reopen terminal items with force:true. Supports id, ids, or items; inspect expectedState/appliedState. Readback mismatches fail.",
                "inputSchema": {
                  "type": "object",
                  "anyOf": [
                    {
                      "type": "object",
                      "properties": {
                        "harness": {
                          "description": "default harness for items that omit one",
                          "type": "string",
                          "maxLength": 80
                        },
                        "reason": {
                          "description": "apply to every row: terminal rows use it as completion evidence, progress rows record it as a comment; blocked rows require a typed blocker and refuse free text",
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 2000
                        },
                        "note": {
                          "description": "same as batch `reason` — apply to every eligible row; pass only one",
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 2000
                        },
                        "items": {
                          "minItems": 1,
                          "maxItems": 200,
                          "type": "array",
                          "items": {
                            "anyOf": [
                              {
                                "type": "object",
                                "properties": {
                                  "id": {
                                    "$ref": "#/$defs/7"
                                  },
                                  "harness": {
                                    "description": "per-item harness (else the batch `harness` default)",
                                    "type": "string",
                                    "maxLength": 80
                                  },
                                  "decision": {
                                    "$ref": "#/$defs/work-items-state-decision-v1"
                                  },
                                  "force": {
                                    "description": "EI-7422: required to REOPEN an item that already carries a terminal completion (terminalOwner + terminalCompletionRef) — without it the write is REJECTED rather than silently discarding a peer's completion. Only needed when the target is already terminal AND you are deliberately reopening it.",
                                    "type": "boolean"
                                  },
                                  "state": {
                                    "$ref": "#/$defs/5"
                                  },
                                  "completionRef": {
                                    "description": "REQUIRED for this terminal state — completion evidence (summary / commit / coord or plan-item ref). Prefer work_items:complete for a structured completion record.",
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 2000
                                  },
                                  "assumptions": {
                                    "$ref": "#/$defs/0"
                                  },
                                  "reason": {
                                    "$ref": "#/$defs/1"
                                  },
                                  "note": {
                                    "$ref": "#/$defs/1"
                                  }
                                },
                                "required": [
                                  "id",
                                  "state",
                                  "assumptions"
                                ],
                                "additionalProperties": false
                              },
                              {
                                "type": "object",
                                "properties": {
                                  "id": {
                                    "$ref": "#/$defs/7"
                                  },
                                  "harness": {
                                    "description": "per-item harness (else the batch `harness` default)",
                                    "type": "string",
                                    "maxLength": 80
                                  },
                                  "decision": {
                                    "$ref": "#/$defs/work-items-state-decision-v1"
                                  },
                                  "force": {
                                    "description": "EI-7422: required to REOPEN an item that already carries a terminal completion (terminalOwner + terminalCompletionRef) — without it the write is REJECTED rather than silently discarding a peer's completion. Only needed when the target is already terminal AND you are deliberately reopening it.",
                                    "type": "boolean"
                                  },
                                  "state": {
                                    "$ref": "#/$defs/3"
                                  },
                                  "reason": {
                                    "description": "why the item moved — recorded as a comment on the item (a non-terminal state has no reason field of its own)",
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 2000
                                  },
                                  "note": {
                                    "description": "same as `reason` — pass only one",
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 2000
                                  }
                                },
                                "required": [
                                  "id",
                                  "state"
                                ],
                                "additionalProperties": false
                              },
                              {
                                "type": "object",
                                "properties": {
                                  "id": {
                                    "$ref": "#/$defs/7"
                                  },
                                  "harness": {
                                    "description": "per-item harness (else the batch `harness` default)",
                                    "type": "string",
                                    "maxLength": 80
                                  },
                                  "decision": {
                                    "$ref": "#/$defs/work-items-state-decision-v1"
                                  },
                                  "force": {
                                    "description": "EI-7422: required to REOPEN an item that already carries a terminal completion (terminalOwner + terminalCompletionRef) — without it the write is REJECTED rather than silently discarding a peer's completion. Only needed when the target is already terminal AND you are deliberately reopening it.",
                                    "type": "boolean"
                                  },
                                  "state": {
                                    "description": "Use only after an active typed blocker exists: call work_items:set_blocker for an external blocker or work_items:link { rel:\"blocks\" } for a work-item dependency. Plan-linked feature items use plans:set-status.",
                                    "type": "string",
                                    "enum": [
                                      "blocked"
                                    ]
                                  }
                                },
                                "required": [
                                  "id",
                                  "state"
                                ],
                                "additionalProperties": false
                              }
                            ]
                          }
                        }
                      },
                      "required": [
                        "items"
                      ],
                      "additionalProperties": false,
                      "x-papercusp-call-constraint": "Within `items:[...]`, a batch-level `reason` or `note` applies to every row and is forbidden when any row state is `blocked` (including legacy aliases). Blocked rows also reject row-level `reason`/`note`; use `work_items:set_blocker` for external blockers or `work_items:link { rel:\"blocks\" }` for a work-item dependency."
                    },
                    {
                      "type": "object",
                      "properties": {
                        "id": {
                          "$ref": "#/$defs/7"
                        },
                        "state": {
                          "$ref": "#/$defs/5"
                        },
                        "harness": {
                          "$ref": "#/$defs/4"
                        },
                        "decision": {
                          "$ref": "#/$defs/2"
                        },
                        "completionRef": {
                          "description": "completion evidence applied to the inline id / every id in `ids` (see itemSpec.completionRef)",
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 2000
                        },
                        "reason": {
                          "$ref": "#/$defs/1"
                        },
                        "note": {
                          "$ref": "#/$defs/1"
                        },
                        "assumptions": {
                          "$ref": "#/$defs/0"
                        },
                        "force": {
                          "description": "required to reopen an already-terminally-completed item; only needed for a deliberate reopen",
                          "type": "boolean"
                        }
                      },
                      "required": [
                        "id",
                        "state",
                        "assumptions"
                      ],
                      "additionalProperties": false
                    },
                    {
                      "type": "object",
                      "properties": {
                        "ids": {
                          "$ref": "#/$defs/6"
                        },
                        "state": {
                          "$ref": "#/$defs/5"
                        },
                        "harness": {
                          "$ref": "#/$defs/4"
                        },
                        "decision": {
                          "$ref": "#/$defs/2"
                        },
                        "completionRef": {
                          "description": "completion evidence applied to the inline id / every id in `ids` (see itemSpec.completionRef)",
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 2000
                        },
                        "reason": {
                          "$ref": "#/$defs/1"
                        },
                        "note": {
                          "$ref": "#/$defs/1"
                        },
                        "assumptions": {
                          "$ref": "#/$defs/0"
                        },
                        "force": {
                          "description": "required to reopen an already-terminally-completed item; only needed for a deliberate reopen",
                          "type": "boolean"
                        }
                      },
                      "required": [
                        "ids",
                        "state",
                        "assumptions"
                      ],
                      "additionalProperties": false
                    },
                    {
                      "type": "object",
                      "properties": {
                        "id": {
                          "$ref": "#/$defs/7"
                        },
                        "state": {
                          "$ref": "#/$defs/3"
                        },
                        "harness": {
                          "$ref": "#/$defs/4"
                        },
                        "decision": {
                          "$ref": "#/$defs/2"
                        },
                        "force": {
                          "description": "required to reopen an already-terminally-completed item; only needed for a deliberate reopen",
                          "type": "boolean"
                        },
                        "reason": {
                          "description": "why the item moved — recorded as a comment on the item (a non-terminal state has no reason field of its own)",
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 2000
                        },
                        "note": {
                          "description": "same as `reason` — pass only one",
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 2000
                        }
                      },
                      "required": [
                        "id",
                        "state"
                      ],
                      "additionalProperties": false
                    },
                    {
                      "type": "object",
                      "properties": {
                        "ids": {
                          "$ref": "#/$defs/6"
                        },
                        "state": {
                          "$ref": "#/$defs/3"
                        },
                        "harness": {
                          "$ref": "#/$defs/4"
                        },
                        "decision": {
                          "$ref": "#/$defs/2"
                        },
                        "force": {
                          "description": "required to reopen an already-terminally-completed item; only needed for a deliberate reopen",
                          "type": "boolean"
                        },
                        "reason": {
                          "description": "why the item moved — recorded as a comment on the item (a non-terminal state has no reason field of its own)",
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 2000
                        },
                        "note": {
                          "description": "same as `reason` — pass only one",
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 2000
                        }
                      },
                      "required": [
                        "ids",
                        "state"
                      ],
                      "additionalProperties": false
                    },
                    {
                      "type": "object",
                      "properties": {
                        "id": {
                          "$ref": "#/$defs/7"
                        },
                        "state": {
                          "description": "Use only after an active typed blocker exists: call work_items:set_blocker for an external blocker or work_items:link { rel:\"blocks\" } for a work-item dependency. Plan-linked feature items use plans:set-status.",
                          "type": "string",
                          "enum": [
                            "blocked"
                          ]
                        },
                        "harness": {
                          "$ref": "#/$defs/4"
                        },
                        "decision": {
                          "$ref": "#/$defs/2"
                        },
                        "force": {
                          "description": "required to reopen an already-terminally-completed item; only needed for a deliberate reopen",
                          "type": "boolean"
                        }
                      },
                      "required": [
                        "id",
                        "state"
                      ],
                      "additionalProperties": false
                    },
                    {
                      "type": "object",
                      "properties": {
                        "ids": {
                          "$ref": "#/$defs/6"
                        },
                        "state": {
                          "description": "Use only after an active typed blocker exists: call work_items:set_blocker for an external blocker or work_items:link { rel:\"blocks\" } for a work-item dependency. Plan-linked feature items use plans:set-status.",
                          "type": "string",
                          "enum": [
                            "blocked"
                          ]
                        },
                        "harness": {
                          "$ref": "#/$defs/4"
                        },
                        "decision": {
                          "$ref": "#/$defs/2"
                        },
                        "force": {
                          "description": "required to reopen an already-terminally-completed item; only needed for a deliberate reopen",
                          "type": "boolean"
                        }
                      },
                      "required": [
                        "ids",
                        "state"
                      ],
                      "additionalProperties": false
                    }
                  ],
                  "$defs": {
                    "0": {
                      "anyOf": [
                        {
                          "minItems": 1,
                          "maxItems": 10,
                          "type": "array",
                          "items": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 120
                          }
                        },
                        {
                          "type": "string",
                          "const": "none"
                        }
                      ],
                      "description": "REQUIRED — the `facts:assert` KEYS this close rests on (e.g. [\"gate-red-is-flake-not-regression\"]), or the literal \"none\" if it rests on no recorded assumption. There is deliberately NO default: a terminal close removes the item from the queue, so a wrong assumption leaves with it and nobody can catch it afterwards. Saying \"none\" is a valid answer; omitting the field is not."
                    },
                    "1": {
                      "description": "alias for `completionRef` on a TERMINAL state — refused on a non-terminal one, which persists no reason field",
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 2000
                    },
                    "2": {
                      "description": "P-114 risk/authority for the inline id / every id in `ids`",
                      "$ref": "#/$defs/work-items-state-decision-v1"
                    },
                    "3": {
                      "type": "string",
                      "enum": [
                        "todo",
                        "in_progress",
                        "validating",
                        "failing",
                        "wip",
                        "needs-human",
                        "open",
                        "in-progress",
                        "inprogress",
                        "in progress",
                        "needs_human",
                        "needshuman",
                        "needs human",
                        "need-human"
                      ]
                    },
                    "4": {
                      "description": "default harness for the inline id / ids",
                      "type": "string",
                      "maxLength": 80
                    },
                    "5": {
                      "type": "string",
                      "enum": [
                        "passed",
                        "deprecated",
                        "done",
                        "dropped",
                        "resolved",
                        "closed"
                      ]
                    },
                    "6": {
                      "minItems": 1,
                      "maxItems": 200,
                      "type": "array",
                      "items": {
                        "$ref": "#/$defs/7"
                      }
                    },
                    "7": {
                      "type": "string",
                      "minLength": 1
                    },
                    "work-items-state-decision-v1": {
                      "type": "object",
                      "properties": {
                        "riskTier": {
                          "type": "string",
                          "enum": [
                            "trivial",
                            "low",
                            "moderate",
                            "high",
                            "critical"
                          ]
                        },
                        "authority": {
                          "type": "string",
                          "enum": [
                            "system",
                            "owner"
                          ]
                        }
                      },
                      "additionalProperties": false
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
                "name": "work_items:complete",
                "description": "Complete work-items with evidence. For terminal closes use `passed`/`deprecated` (feature/chunk) or `resolved`/`closed` (issue); `done`/`dropped` aliases are accepted. `closed`/`deprecated` discard work. Pass terminal `state` plus `assumptions` (`\"none\"` or fact keys); deliberate record-only calls pass `recordOnly:true`.",
                "inputSchema": {
                  "type": "object",
                  "anyOf": [
                    {
                      "type": "object",
                      "properties": {
                        "whatLanded": {
                          "type": "array",
                          "items": {
                            "type": "string",
                            "minLength": 1
                          }
                        },
                        "migrations": {
                          "type": "array",
                          "items": {
                            "type": "string",
                            "minLength": 1
                          }
                        },
                        "deferred": {
                          "type": "array",
                          "items": {
                            "type": "string",
                            "minLength": 1
                          }
                        },
                        "summary": {
                          "type": "string",
                          "minLength": 1
                        },
                        "status": {
                          "type": "string",
                          "minLength": 1
                        },
                        "tests": {
                          "type": "string",
                          "minLength": 1
                        },
                        "testsRun": {
                          "type": "string",
                          "minLength": 1
                        },
                        "testResult": {
                          "type": "string",
                          "minLength": 1
                        },
                        "verifiedHow": {
                          "$ref": "#/$defs/2"
                        },
                        "deploy": {
                          "type": "string",
                          "minLength": 1
                        },
                        "coordNotes": {
                          "type": "string",
                          "minLength": 1
                        },
                        "planSlug": {
                          "type": "string",
                          "minLength": 1
                        },
                        "agent": {
                          "type": "string",
                          "minLength": 1
                        },
                        "title": {
                          "type": "string"
                        },
                        "workItem": {
                          "type": "string",
                          "minLength": 1
                        },
                        "addedTests": {
                          "description": "A boolean FLAG — did this completion add or change tests? true/false, NOT a description of what was added (put that prose in `testsRun` / `testResult`).",
                          "type": "boolean"
                        },
                        "filesChanged": {
                          "$ref": "#/$defs/0"
                        },
                        "filesDeleted": {
                          "$ref": "#/$defs/0"
                        },
                        "verification": {
                          "description": "Legacy flat alias; the typed shape is `completion.verification`.",
                          "type": "object",
                          "propertyNames": {
                            "type": "string"
                          },
                          "additionalProperties": {}
                        },
                        "coverage": {
                          "description": "Legacy flat alias; the typed shape is `completion.coverage`.",
                          "type": "object",
                          "propertyNames": {
                            "type": "string"
                          },
                          "additionalProperties": {}
                        },
                        "rootCauseVerification": {
                          "description": "Legacy flat alias; the typed shape is `completion.rootCauseVerification`.",
                          "type": "object",
                          "propertyNames": {
                            "type": "string"
                          },
                          "additionalProperties": {}
                        },
                        "selfReview": {
                          "description": "Legacy flat alias; the typed shape is `completion.selfReview`.",
                          "type": "object",
                          "propertyNames": {
                            "type": "string"
                          },
                          "additionalProperties": {}
                        },
                        "id": {
                          "description": "single-complete shorthand: the work-item id (use with `completion`)",
                          "type": "string",
                          "minLength": 1
                        },
                        "harness": {
                          "description": "default harness for the inline id / items that omit one",
                          "type": "string",
                          "maxLength": 80
                        },
                        "state": {
                          "description": "Terminal intent: feature/chunk uses 'passed'|'deprecated' and issue uses 'resolved'|'closed'; unified 'done'|'dropped' aliases are also accepted. 'dropped'/'closed'/'deprecated' mean discard or wontfix; never use them for successful work.",
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 40
                        },
                        "recordOnly": {
                          "description": "Explicitly record and emit without changing lifecycle state.",
                          "type": "boolean"
                        },
                        "boundaryNote": {
                          "$ref": "#/$defs/5"
                        },
                        "completion": {
                          "$ref": "#/$defs/wi-completion"
                        },
                        "outputPayload": {
                          "type": "object",
                          "additionalProperties": true,
                          "description": "matches any object value"
                        },
                        "specAdequacy": {
                          "$ref": "#/$defs/wi-adequacy"
                        },
                        "validateOnly": {
                          "type": "boolean"
                        },
                        "assumptions": {
                          "$ref": "#/$defs/b"
                        },
                        "changeKinds": {
                          "$ref": "#/$defs/1"
                        },
                        "changeKindReason": {
                          "$ref": "#/$defs/3"
                        },
                        "items": {
                          "not": {}
                        }
                      },
                      "additionalProperties": false
                    },
                    {
                      "type": "object",
                      "properties": {
                        "id": {
                          "type": "string",
                          "minLength": 1
                        },
                        "harness": {
                          "description": "default harness for the inline id / items that omit one",
                          "type": "string",
                          "maxLength": 80
                        },
                        "state": {
                          "description": "Default terminal intent for items that omit one. Feature/chunk success: 'passed'; issue success: 'resolved'. Legacy discard/wontfix: 'deprecated' or 'closed'; unified aliases 'done'|'dropped' are also accepted.",
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 40
                        },
                        "recordOnly": {
                          "description": "Default record-only intent for items that omit their own state.",
                          "type": "boolean"
                        },
                        "boundaryNote": {
                          "description": "Default successor/boundary note for items that omit one; posted only after that item's terminal finish cleanup converges.",
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 2000
                        },
                        "completion": {
                          "$ref": "#/$defs/wi-completion"
                        },
                        "outputPayload": {
                          "type": "object",
                          "additionalProperties": true,
                          "description": "matches any object value"
                        },
                        "validateOnly": {
                          "type": "boolean"
                        },
                        "assumptions": {
                          "$ref": "#/$defs/b"
                        },
                        "changeKinds": {
                          "$ref": "#/$defs/1"
                        },
                        "changeKindReason": {
                          "$ref": "#/$defs/3"
                        },
                        "items": {
                          "minItems": 1,
                          "maxItems": 100,
                          "type": "array",
                          "items": {
                            "type": "object",
                            "properties": {
                              "id": {
                                "type": "string",
                                "minLength": 1
                              },
                              "harness": {
                                "description": "per-item harness (else the batch `harness` default)",
                                "type": "string",
                                "maxLength": 80
                              },
                              "state": {
                                "description": "Terminal lifecycle intent. Feature/chunk success: 'passed'; issue success: 'resolved'. Unified 'done'/'dropped' aliases are accepted and preserve success vs discard semantics. Legacy 'deprecated'/'closed' are discard/wontfix. Never use 'closed' as a generic synonym for successful work. To omit state deliberately, pass recordOnly:true.",
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 40
                              },
                              "recordOnly": {
                                "description": "Explicitly record and emit a completion without changing lifecycle state.",
                                "type": "boolean"
                              },
                              "completion": {
                                "$ref": "#/$defs/wi-completion"
                              },
                              "outputPayload": {
                                "type": "object",
                                "additionalProperties": true,
                                "description": "matches any object value"
                              },
                              "specAdequacy": {
                                "$ref": "#/$defs/wi-adequacy"
                              },
                              "validateOnly": {
                                "type": "boolean"
                              },
                              "assumptions": {
                                "$ref": "#/$defs/b"
                              },
                              "boundaryNote": {
                                "$ref": "#/$defs/5"
                              },
                              "changeKinds": {
                                "$ref": "#/$defs/1"
                              },
                              "changeKindReason": {
                                "$ref": "#/$defs/3"
                              }
                            },
                            "required": [
                              "id",
                              "completion"
                            ],
                            "additionalProperties": false
                          },
                          "description": "complete many work-items at once — each { id, completion, assumptions, state?, harness? }; an omitted per-item state/harness falls back to the top-level one"
                        }
                      },
                      "required": [
                        "items"
                      ],
                      "additionalProperties": false
                    }
                  ],
                  "$defs": {
                    "0": {
                      "description": "Use repo-relative paths for files in managed checkouts. For an out-of-tree deliverable, use its absolute path; work_items:complete records it as outOfRepoArtifact and excludes it from Git blob and settlement checks. External contents are not hashed. Do not use a repo-relative alias for an out-of-tree file because it is indistinguishable from a missing checkout path. If NO files changed, pass [].",
                      "type": "array",
                      "items": {
                        "type": "string",
                        "minLength": 1
                      }
                    },
                    "1": {
                      "x-papercusp-call-constraint": "A successful close uses stored `changeKinds` or this declaration; a first declaration needs `changeKindReason`.",
                      "minItems": 1,
                      "maxItems": 10,
                      "type": "array",
                      "items": {
                        "$ref": "#/$defs/8"
                      },
                      "description": "The kind(s) of change this work makes, from the bundled catalog: ui, service, migration, background-job, logic, refactor, docs, config, test-only, no-code-change. A successful close must carry each kind's proof. Re-declaring later keeps the earlier declaration in history."
                    },
                    "2": {
                      "type": "string",
                      "minLength": 1,
                      "description": "HOW it was verified — a non-empty label. Prefer 'unit' | 'integration' | 'live-drove-ui' | 'live-service' | 'manual' | 'already-passing' for queryable coarse modes; concise free-text labels are also accepted. `live-service` means a real running process/service was restarted or probed without driving UI. Put detailed evidence in `testsRun` / `testResult`."
                    },
                    "3": {
                      "x-papercusp-call-constraint": "First close-time declaration needs this reason (why absent at create/claim/checkpoint); unexplained narrowing or a UI-file mismatch leaves the close proposed.",
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 1000,
                      "description": "Why the declared kinds changed or were first declared late. Stored with the declaration."
                    },
                    "4": {
                      "description": "For a linked-plan terminal close, declare mapped R-* keys shown in the spec-conformance-closure row of the returned completionContract.",
                      "maxItems": 200,
                      "type": "array",
                      "items": {
                        "type": "string",
                        "pattern": "^R-\\d+$"
                      }
                    },
                    "5": {
                      "description": "Optional successor/boundary note to append after a terminal close and finish cleanup; ignored for record-only or non-terminal results.",
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 2000
                    },
                    "6": {
                      "anyOf": [
                        {
                          "$ref": "#/$defs/a"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "7": {
                      "type": "integer",
                      "exclusiveMinimum": 0,
                      "maximum": 9007199254740991
                    },
                    "8": {
                      "type": "string",
                      "enum": [
                        "ui",
                        "service",
                        "migration",
                        "background-job",
                        "logic",
                        "refactor",
                        "docs",
                        "config",
                        "test-only",
                        "no-code-change"
                      ]
                    },
                    "9": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 4000
                    },
                    "wi-completion": {
                      "description": "Structured completion record; its fields and types are published in this schema. `completion` owns `testsRun`, `testResult`, `verifiedHow`, and `filesChanged`; `completion.verification` is for structured coverage. The single-item call also accepts those fields at the argument root as legacy aliases. Do not put test/typecheck/diff details under the strict `completion.verification`; keep `deferred`/`coordNotes` at completion level, not inside `verification`. For a terminal close, `verifiedHow:'live-drove-ui'` requires a real artifact citation in `summary`, `testsRun`, `testResult`, or `filesChanged` — DESKTOP: a screenshot/capture image path retained outside session scratch, or a recorded `tauri-agent-tools` capture/screenshot/check invocation; WEB: the deployed URL with its HTTP status, or a recorded browser-driver run (playwright/puppeteer/verdict) naming the http(s) target it drove. `verifiedHow:'live-service'` requires `testsRun`/`testResult` to jointly name the concrete service/unit/process and a falsifiable runtime observation (`MainPID`, `NRestarts`, `ActiveState`, or an HTTP status). Use 'unit'/'manual'/'integration' when no live artifact or runtime process was inspected. `coordNotes` is ALSO harvested into the observation lane: its FIRST LINE becomes the observation title, so lead that line with the stable subject (tool/verb name, surface, file path, error class) and keep the narrative on the lines below — recurrence is matched on that line alone. A bare STRING is rejected because it cannot carry structured evidence. completion must be a structured object, not a bare string. Pass completion: { summary: \"what changed\", testsRun: \"npm run test:file -- path/to.test.ts\", testResult: \"passed\", verifiedHow: \"unit\", addedTests: true, filesChanged: [\"path/to/file\"], filesDeleted: [\"path/to/removed\"], verification: { coverage: { population: [\"all named items\"], checked: [\"all named items\"], notChecked: [], notApplicable: [], residue: [\"none\"] } } }. Bug/capability-gap terminal closes also require `rootCauseVerification` (its own schema lists the keys).",
                      "type": "object",
                      "properties": {
                        "workItem": {
                          "type": "string",
                          "minLength": 1
                        },
                        "title": {
                          "type": "string"
                        },
                        "summary": {
                          "type": "string",
                          "minLength": 1
                        },
                        "discharges": {
                          "$ref": "#/$defs/4"
                        },
                        "contributesTo": {
                          "$ref": "#/$defs/4"
                        },
                        "status": {
                          "type": "string",
                          "minLength": 1
                        },
                        "whatLanded": {
                          "type": "array",
                          "items": {
                            "type": "string",
                            "minLength": 1
                          }
                        },
                        "migrations": {
                          "type": "array",
                          "items": {
                            "type": "string",
                            "minLength": 1
                          }
                        },
                        "tests": {
                          "type": "string",
                          "minLength": 1
                        },
                        "verification": {
                          "type": "object",
                          "properties": {
                            "filesChanged": {
                              "$ref": "#/$defs/0"
                            },
                            "filesDeleted": {
                              "$ref": "#/$defs/0"
                            },
                            "testsRun": {
                              "type": "string",
                              "minLength": 1
                            },
                            "testResult": {
                              "type": "string",
                              "minLength": 1
                            },
                            "verifiedHow": {
                              "$ref": "#/$defs/2"
                            },
                            "workOutcome": {
                              "type": "string",
                              "enum": [
                                "introduced-change",
                                "verified-existing",
                                "duplicate",
                                "invalid-or-expected",
                                "other-no-new-change"
                              ]
                            },
                            "addedTests": {
                              "description": "A boolean FLAG — did this completion add or change tests? true/false, NOT a description of what was added (put that prose in `testsRun` / `testResult`).",
                              "type": "boolean"
                            },
                            "coverage": {
                              "$ref": "#/$defs/wi-coverage"
                            },
                            "requirementDisposition": {
                              "type": "array",
                              "items": {
                                "type": "object",
                                "properties": {
                                  "requirement": {
                                    "type": "string",
                                    "minLength": 1,
                                    "description": "VERBATIM quote from the originating item body — never a paraphrase."
                                  },
                                  "disposition": {
                                    "type": "string",
                                    "enum": [
                                      "implemented",
                                      "not-applicable",
                                      "deferred",
                                      "rejected"
                                    ]
                                  },
                                  "citations": {
                                    "description": "Repo-relative paths that must RESOLVE; required for `implemented`.",
                                    "type": "array",
                                    "items": {
                                      "type": "string",
                                      "minLength": 1
                                    }
                                  },
                                  "followUp": {
                                    "description": "Filed work-item ref (WI-/EI-/F-); required for `deferred`.",
                                    "type": "string",
                                    "minLength": 1
                                  },
                                  "note": {
                                    "type": "string",
                                    "minLength": 1
                                  }
                                },
                                "required": [
                                  "requirement",
                                  "disposition"
                                ],
                                "additionalProperties": false
                              },
                              "description": "Requirement-by-requirement disposition of the ask. Each `requirement` is a VERBATIM quote from the originating item body (substring-checked, never paraphrased), each `implemented` cites a path that resolves, each `deferred` names a filed follow-up ref."
                            },
                            "summary": {
                              "type": "string",
                              "minLength": 1
                            },
                            "claims": {
                              "description": "Optional machine-checkable assertions about the source (\"X is in array Y\", \"X is defined in Z\"). The server RE-EVALUATES each against the tree: a false one downgrades this close to proposed and is named back to you. Undecidable ones are ignored, never treated as passing.",
                              "maxItems": 50,
                              "type": "array",
                              "items": {
                                "oneOf": [
                                  {
                                    "type": "object",
                                    "properties": {
                                      "kind": {
                                        "type": "string",
                                        "const": "string-in-array"
                                      },
                                      "path": {
                                        "type": "string",
                                        "minLength": 1
                                      },
                                      "container": {
                                        "type": "string",
                                        "minLength": 1
                                      },
                                      "value": {
                                        "type": "string",
                                        "minLength": 1
                                      },
                                      "expect": {
                                        "type": "string",
                                        "enum": [
                                          "present",
                                          "absent"
                                        ]
                                      }
                                    },
                                    "required": [
                                      "kind",
                                      "path",
                                      "container",
                                      "value",
                                      "expect"
                                    ],
                                    "additionalProperties": false
                                  },
                                  {
                                    "type": "object",
                                    "properties": {
                                      "kind": {
                                        "type": "string",
                                        "const": "symbol-defined"
                                      },
                                      "path": {
                                        "type": "string",
                                        "minLength": 1
                                      },
                                      "symbol": {
                                        "type": "string",
                                        "minLength": 1
                                      },
                                      "expect": {
                                        "type": "string",
                                        "enum": [
                                          "present",
                                          "absent"
                                        ]
                                      },
                                      "exported": {
                                        "type": "boolean"
                                      }
                                    },
                                    "required": [
                                      "kind",
                                      "path",
                                      "symbol",
                                      "expect"
                                    ],
                                    "additionalProperties": false
                                  }
                                ]
                              }
                            }
                          },
                          "additionalProperties": false,
                          "description": "Server-stamped verification metadata: the server records `treeStamp` and `settlementManifest`; callers must omit `treeStamp` and `settlementManifest`. Their persisted headSha is a full lowercase 40- or 64-character commit SHA; short hashes are invalid."
                        },
                        "kindEvidence": {
                          "x-papercusp-call-constraint": "Multi-kind close needs one `completion.kindEvidence` entry per declared kind. Required fields: ui=testsRun+testResult+artifacts+build+states+distinguishingChecks; service=testsRun+testResult+build; migration=database+testsRun+testResult; background-job=runtime+testsRun+testResult; logic/test-only=testsRun+testResult; config/docs=readBack. Single-kind may reuse root evidence when allowed; no-code-change needs empty root filesChanged/filesDeleted.",
                          "minItems": 1,
                          "maxItems": 10,
                          "type": "array",
                          "items": {
                            "type": "object",
                            "properties": {
                              "kind": {
                                "$ref": "#/$defs/8"
                              },
                              "summary": {
                                "$ref": "#/$defs/9"
                              },
                              "testsRun": {
                                "description": "The command or probe run for this kind.",
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 4000
                              },
                              "testResult": {
                                "description": "The current run result. Use testResultPhases when retaining baseline results.",
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 4000
                              },
                              "testResultPhases": {
                                "description": "Structured test history: at least one baseline phase and exactly one current phase. Only the current phase proves passing behavior; historical baseline failures remain visible without being treated as current failures.",
                                "minItems": 2,
                                "maxItems": 10,
                                "type": "array",
                                "items": {
                                  "type": "object",
                                  "properties": {
                                    "phase": {
                                      "type": "string",
                                      "enum": [
                                        "baseline",
                                        "current"
                                      ]
                                    },
                                    "testsRun": {
                                      "type": "string",
                                      "minLength": 1,
                                      "maxLength": 4000,
                                      "description": "The command or probe for this phase."
                                    },
                                    "testResult": {
                                      "type": "string",
                                      "minLength": 1,
                                      "maxLength": 4000,
                                      "description": "The observed result for this phase."
                                    }
                                  },
                                  "required": [
                                    "phase",
                                    "testsRun",
                                    "testResult"
                                  ],
                                  "additionalProperties": false
                                }
                              },
                              "artifacts": {
                                "description": "ui: retained artifact paths or URLs from the real-app run (screenshot, capture, DOM snapshot).",
                                "maxItems": 50,
                                "type": "array",
                                "items": {
                                  "$ref": "#/$defs/9"
                                }
                              },
                              "build": {
                                "description": "ui/service: the build the run or call used, proving it contained this change — its commit/build sha (for example from /api/health) or a VERIFY_TAURI_ASSERT_SNAPSHOT_CONTAINS check.",
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 4000
                              },
                              "states": {
                                "description": "ui: every user-visible state you changed, each with where the run covered it.",
                                "maxItems": 50,
                                "type": "array",
                                "items": {
                                  "type": "object",
                                  "properties": {
                                    "name": {
                                      "$ref": "#/$defs/9"
                                    },
                                    "evidence": {
                                      "$ref": "#/$defs/9"
                                    }
                                  },
                                  "required": [
                                    "name",
                                    "evidence"
                                  ],
                                  "additionalProperties": false
                                }
                              },
                              "distinguishingChecks": {
                                "description": "ui: at least one check whose expected value tells the right result apart from a plausible wrong one.",
                                "maxItems": 20,
                                "type": "array",
                                "items": {
                                  "type": "object",
                                  "properties": {
                                    "assertion": {
                                      "type": "string",
                                      "minLength": 1,
                                      "maxLength": 4000,
                                      "description": "What the check asserted."
                                    },
                                    "expected": {
                                      "type": "string",
                                      "minLength": 1,
                                      "maxLength": 4000,
                                      "description": "The value the right result produces."
                                    },
                                    "plausibleWrong": {
                                      "type": "string",
                                      "minLength": 1,
                                      "maxLength": 4000,
                                      "description": "The value a plausible wrong result would produce instead."
                                    }
                                  },
                                  "required": [
                                    "assertion",
                                    "expected",
                                    "plausibleWrong"
                                  ],
                                  "additionalProperties": false
                                }
                              },
                              "database": {
                                "description": "migration: the disposable database the migration was applied to.",
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 4000
                              },
                              "runtime": {
                                "description": "background-job: the isolated runtime the job ran in.",
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 4000
                              },
                              "readBack": {
                                "description": "config: the effective value read back from its consumer. docs: the document read back from where readers get it.",
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 4000
                              },
                              "landingCommit": {
                                "description": "refactor: the sha of the commit that landed the refactor.",
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 4000
                              },
                              "beforeRuns": {
                                "description": "refactor: test_runs row ids for the covering test files at the landing change's parent.",
                                "maxItems": 200,
                                "type": "array",
                                "items": {
                                  "$ref": "#/$defs/7"
                                }
                              },
                              "afterRuns": {
                                "description": "refactor: test_runs row ids for exactly the same test files at the landing change.",
                                "maxItems": 200,
                                "type": "array",
                                "items": {
                                  "$ref": "#/$defs/7"
                                }
                              },
                              "finding": {
                                "description": "refactor: the targeted finding (for example a clone-family key) that must be absent on re-scan.",
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 4000
                              },
                              "typecheck": {
                                "description": "refactor: the lint:tsc result for the changed files (for example \"LINT_TSC_RESULT status=clean\").",
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 4000
                              },
                              "behaviouralStrands": {
                                "description": "refactor: the lint:behavioural-strands result (exit 0, no strands).",
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 4000
                              }
                            },
                            "required": [
                              "kind"
                            ],
                            "additionalProperties": false
                          },
                          "description": "Proof per declared change kind: one { kind, ... } entry each. Required when more than one kind is declared; a single-kind close may use the root summary/testsRun/testResult instead."
                        },
                        "typeFields": {
                          "description": "Fields the linked plan item's item type declares",
                          "type": "object",
                          "propertyNames": {
                            "type": "string"
                          },
                          "additionalProperties": {}
                        },
                        "rootCauseVerification": {
                          "x-papercusp-call-constraint": "successful bug/capability-gap close (state=done|resolved|passed) => required; contractVersion=2; required fields: hypothesis, alternativeHypothesis, distinguishingTest, testResult, testProcedure, predictedObservations.hypothesis, predictedObservations.alternativeHypothesis, actualObservation, evidenceRefs; hypothesis!=alternativeHypothesis; predictedObservations arms must be meaningfully different; distinguishingTest: non-empty procedure; no prose template required",
                          "type": "object",
                          "properties": {
                            "contractVersion": {
                              "type": "number",
                              "const": 2
                            },
                            "hypothesis": {
                              "type": "string",
                              "minLength": 1,
                              "description": "The claimed originating cause."
                            },
                            "alternativeHypothesis": {
                              "type": "string",
                              "minLength": 1,
                              "description": "A rival explanation that predicts a different result."
                            },
                            "distinguishingTest": {
                              "type": "string",
                              "minLength": 1,
                              "description": "non-empty procedure; no prose template required"
                            },
                            "testResult": {
                              "type": "string",
                              "minLength": 1,
                              "description": "The actual pre-fix observable."
                            },
                            "testProcedure": {
                              "description": "Exact procedure used to distinguish the two hypotheses; required on new successful defect closes.",
                              "type": "string",
                              "minLength": 1
                            },
                            "predictedObservations": {
                              "description": "The observation predicted under each hypothesis; required on new successful defect closes.",
                              "type": "object",
                              "properties": {
                                "hypothesis": {
                                  "type": "string",
                                  "minLength": 1
                                },
                                "alternativeHypothesis": {
                                  "type": "string",
                                  "minLength": 1
                                }
                              },
                              "required": [
                                "hypothesis",
                                "alternativeHypothesis"
                              ],
                              "additionalProperties": false
                            },
                            "actualObservation": {
                              "description": "What the distinguishing procedure actually observed; required on new successful defect closes.",
                              "type": "string",
                              "minLength": 1
                            },
                            "evidenceRefs": {
                              "description": "Durable references supporting the procedure and actual observation; required on new successful defect closes.",
                              "minItems": 1,
                              "maxItems": 50,
                              "type": "array",
                              "items": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 2000
                              }
                            }
                          },
                          "required": [
                            "hypothesis",
                            "alternativeHypothesis",
                            "distinguishingTest",
                            "testResult"
                          ],
                          "additionalProperties": false
                        },
                        "verificationVerdict": {
                          "x-papercusp-call-constraint": "closing a completion verification task (payload.verification.check='completion') => required; reject => reason required",
                          "type": "object",
                          "properties": {
                            "verdict": {
                              "type": "string",
                              "enum": [
                                "accept",
                                "reject"
                              ]
                            },
                            "reason": {
                              "type": "string",
                              "minLength": 1
                            }
                          },
                          "required": [
                            "verdict"
                          ],
                          "additionalProperties": false
                        },
                        "coverage": {
                          "$ref": "#/$defs/wi-coverage"
                        },
                        "filesChanged": {
                          "$ref": "#/$defs/0"
                        },
                        "filesDeleted": {
                          "$ref": "#/$defs/0"
                        },
                        "testsRun": {
                          "type": "string",
                          "minLength": 1
                        },
                        "testResult": {
                          "type": "string",
                          "minLength": 1
                        },
                        "verifiedHow": {
                          "$ref": "#/$defs/2"
                        },
                        "addedTests": {
                          "description": "A boolean FLAG — did this completion add or change tests? true/false, NOT a description of what was added (put that prose in `testsRun` / `testResult`).",
                          "type": "boolean"
                        },
                        "selfReview": {
                          "type": "object",
                          "properties": {
                            "lookedAt": {
                              "type": "string",
                              "minLength": 1
                            },
                            "findings": {
                              "type": "array",
                              "items": {
                                "type": "string",
                                "minLength": 1
                              }
                            },
                            "changedAsResult": {
                              "type": "array",
                              "items": {
                                "type": "string",
                                "minLength": 1
                              }
                            }
                          },
                          "additionalProperties": false
                        },
                        "deploy": {
                          "type": "string",
                          "minLength": 1
                        },
                        "deferred": {
                          "type": "array",
                          "items": {
                            "type": "string",
                            "minLength": 1
                          }
                        },
                        "coordNotes": {
                          "type": "string",
                          "minLength": 1
                        },
                        "planSlug": {
                          "type": "string",
                          "minLength": 1
                        },
                        "agent": {
                          "type": "string",
                          "minLength": 1
                        },
                        "duplicateOf": {
                          "type": "string",
                          "minLength": 1
                        },
                        "__shapeCoercedFrom": {
                          "type": "string",
                          "const": "truncated-json"
                        },
                        "__statusDefaulted": {
                          "type": "boolean",
                          "const": true
                        }
                      },
                      "required": [
                        "summary"
                      ],
                      "additionalProperties": false
                    },
                    "wi-coverage": {
                      "x-papercusp-call-constraint": "terminal state=done|resolved|passed => coverage required; population once; residue:[]|residue:['none']",
                      "description": "Coverage contract: population, checked, notChecked, and notApplicable are the partition buckets; residue is a separate list, never a fifth bucket. Every population entry must appear verbatim in exactly one status bucket. All buckets are string arrays; an explicit empty residue array (residue:[]) declares zero residue, and residue:['none'] remains accepted as a compatibility form. Universal-verification closes must include the residue array. Omitted status buckets mean empty buckets.",
                      "type": "object",
                      "properties": {
                        "population": {
                          "minItems": 1,
                          "type": "array",
                          "items": {
                            "type": "string",
                            "minLength": 1
                          },
                          "description": "The complete, uniquely named population. Copy each entry verbatim into exactly one status bucket."
                        },
                        "checked": {
                          "description": "Population entries verified as checked; entries must be copied verbatim and appear at most once.",
                          "type": "array",
                          "items": {
                            "type": "string",
                            "minLength": 1
                          }
                        },
                        "notChecked": {
                          "description": "Population entries not verified; entries must be copied verbatim and appear at most once.",
                          "type": "array",
                          "items": {
                            "type": "string",
                            "minLength": 1
                          }
                        },
                        "notApplicable": {
                          "description": "Population entries that do not apply; entries must be copied verbatim and appear at most once.",
                          "type": "array",
                          "items": {
                            "type": "string",
                            "minLength": 1
                          }
                        },
                        "residue": {
                          "description": "A separate residue list, never a partition bucket; for universal closes it must be present and may be empty. Use [] or ['none'] for zero residue.",
                          "type": "array",
                          "items": {
                            "type": "string",
                            "minLength": 1
                          }
                        }
                      },
                      "required": [
                        "population"
                      ],
                      "additionalProperties": false
                    },
                    "wi-adequacy": {
                      "type": "object",
                      "properties": {
                        "classRef": {
                          "description": "Derived from each persisted subject plan class when omitted; explicit values must match. Ad-hoc scopes require an explicit class attestation.",
                          "type": "string",
                          "enum": [
                            "plan-class-feature-ship",
                            "plan-class-bugfix",
                            "plan-class-migration",
                            "plan-class-investigation",
                            "plan-class-general"
                          ]
                        },
                        "evidenceRefs": {
                          "description": "Exact immutable evidence identities to grade. Use this to exclude superseded run-specific bindings without deleting history; include every relied-on ref across the enforced clauses.",
                          "minItems": 1,
                          "maxItems": 500,
                          "type": "array",
                          "items": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 2000
                          }
                        },
                        "specRevision": {
                          "$ref": "#/$defs/7"
                        },
                        "specFingerprint": {
                          "$ref": "#/$defs/a"
                        },
                        "replaySnapshot": {
                          "type": "boolean"
                        },
                        "current": {
                          "description": "Current fingerprints for the exact bound evidence refs. `specAdequacy.current` entries use `{ planSlug?, specId?, specRevision?, specFingerprint?, evidenceKind, evidenceRef, sourceFingerprint, testFingerprint?, fixtureFingerprint?, rubricFingerprint?, environmentFingerprint? }`; provide one entry for every selected bound evidence ref (`specAdequacy.evidenceRefs` narrows the selection; when omitted, use all bound refs) and every stored fingerprint dimension. `planSlug`, `specId`, `specRevision`, and `specFingerprint` are an all-or-none clause identity; omitted values remain unknown and cannot pass.",
                          "maxItems": 500,
                          "type": "array",
                          "items": {
                            "type": "object",
                            "properties": {
                              "planSlug": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 2000
                              },
                              "specId": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 2000
                              },
                              "specRevision": {
                                "$ref": "#/$defs/7"
                              },
                              "specFingerprint": {
                                "$ref": "#/$defs/a"
                              },
                              "evidenceKind": {
                                "type": "string",
                                "enum": [
                                  "test",
                                  "fixture",
                                  "coverage-census",
                                  "mutation",
                                  "counterexample",
                                  "check",
                                  "manual",
                                  "operational",
                                  "independent-verification"
                                ]
                              },
                              "evidenceRef": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 2000
                              },
                              "sourceFingerprint": {
                                "$ref": "#/$defs/a"
                              },
                              "testFingerprint": {
                                "$ref": "#/$defs/6"
                              },
                              "fixtureFingerprint": {
                                "$ref": "#/$defs/6"
                              },
                              "rubricFingerprint": {
                                "$ref": "#/$defs/6"
                              },
                              "environmentFingerprint": {
                                "$ref": "#/$defs/6"
                              }
                            },
                            "required": [
                              "evidenceKind",
                              "evidenceRef",
                              "sourceFingerprint"
                            ],
                            "additionalProperties": false
                          }
                        }
                      },
                      "additionalProperties": false,
                      "description": "Required on a terminal close that covers active test-requiring spec clauses. The gate recomputes per-clause adequacy over the optional exact evidenceRefs selection and accepts only exact current terminal scorecards whose grading audit is settled. A single-clause replay supplies specRevision + specFingerprint; a multi-clause replay supplies full clause identity on every current[] row with replaySnapshot:true."
                    },
                    "wi-assumptions": {
                      "description": "Required for a terminal close; omit for record-only completions. Pass \"none\" or fact keys.",
                      "anyOf": [
                        {
                          "minItems": 1,
                          "maxItems": 10,
                          "type": "array",
                          "items": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 120
                          }
                        },
                        {
                          "type": "string",
                          "const": "none"
                        }
                      ]
                    },
                    "a": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 256
                    },
                    "b": {
                      "$ref": "#/$defs/wi-assumptions"
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
              },
              {
                "name": "work_items:claim",
                "description": "Claim one or many work-items for yourself or an assignee. Single: { id, assignee? }; many: ids:[…] or items:[{ id, assignee?, harness? }]. Results are independent. Fleet members receive only items matching their claim spec. Named claims override readiness floors, not terminal state, fleet scope or born-pending admission/trust; server-derived dispatch/force may bypass pending rows. Reopen terminal work first with work_items:set_state { force:true, reason }. `force:true` here is an audited, liveness-checked holder takeover.",
                "inputSchema": {
                  "type": "object",
                  "oneOf": [
                    {
                      "type": "object",
                      "additionalProperties": false,
                      "required": [
                        "row"
                      ],
                      "properties": {
                        "row": {
                          "type": "string",
                          "description": "Comma-separated VALUES in column order: id, assignee?, harness?, force?, reason?. Omit trailing optional columns. The last column is free-text and may contain commas — do not quote it."
                        }
                      }
                    },
                    {
                      "type": "object",
                      "properties": {
                        "id": {
                          "description": "single-claim shorthand: the work-item id",
                          "type": "string",
                          "minLength": 1
                        },
                        "assignee": {
                          "description": "default: you (also resolves the literal \"self\" to you). Applies to the inline id / every id in `ids`.",
                          "type": "string",
                          "maxLength": 120
                        },
                        "ids": {
                          "description": "claim MANY items for the same `assignee` (homogeneous)",
                          "minItems": 1,
                          "maxItems": 200,
                          "type": "array",
                          "items": {
                            "type": "string",
                            "minLength": 1
                          }
                        },
                        "items": {
                          "description": "claim many work-items at once — each { id, assignee?, harness?, force?, reason?, changeKinds? }",
                          "minItems": 1,
                          "maxItems": 200,
                          "type": "array",
                          "items": {
                            "type": "object",
                            "properties": {
                              "id": {
                                "type": "string",
                                "minLength": 1
                              },
                              "assignee": {
                                "type": "string",
                                "maxLength": 120
                              },
                              "harness": {
                                "type": "string",
                                "maxLength": 80
                              },
                              "force": {
                                "type": "boolean"
                              },
                              "reason": {
                                "type": "string",
                                "maxLength": 500
                              },
                              "pilotRole": {
                                "type": "string",
                                "enum": [
                                  "solo",
                                  "director",
                                  "implementer"
                                ]
                              },
                              "directiveRef": {
                                "type": "integer",
                                "exclusiveMinimum": 0,
                                "maximum": 9007199254740991
                              },
                              "changeKinds": {
                                "$ref": "#/$defs/0"
                              },
                              "changeKindReason": {
                                "$ref": "#/$defs/1"
                              }
                            },
                            "required": [
                              "id"
                            ],
                            "additionalProperties": false
                          }
                        },
                        "harness": {
                          "description": "default harness for the inline id / ids / items that omit one",
                          "type": "string",
                          "maxLength": 80
                        },
                        "force": {
                          "description": "default for the inline id / every id in `ids`: checked-reclaim another agent's non-terminal claim with `reason`; terminal items must first be explicitly reopened with work_items:set_state. Self-select readiness floors are overridden by naming an id, but terminal state and ordinary born-pending admission remain enforced.",
                          "type": "boolean"
                        },
                        "reason": {
                          "description": "default for the inline id / every id in `ids`: required when `force:true` replaces another agent's claim; recorded in the forced result, audit, and holder/owner notifications. A terminal reopen reason belongs on work_items:set_state.",
                          "type": "string",
                          "maxLength": 500
                        },
                        "pilotRole": {
                          "description": "directed-pair pilot only: mint a server-issued canonical binding receipt for this caller-owned claim",
                          "type": "string",
                          "enum": [
                            "solo",
                            "director",
                            "implementer"
                          ]
                        },
                        "directiveRef": {
                          "description": "owner-directive provenance (orders id): bind this already-existing item to the directive you are claiming it to carry out. Write-once — a claim on an item already bound to a DIFFERENT directive still claims, and reports directiveBindWarning rather than re-pointing it. Use work_items:create { directiveRef } instead when the item does not exist yet.",
                          "type": "integer",
                          "exclusiveMinimum": 0,
                          "maximum": 9007199254740991
                        },
                        "changeKinds": {
                          "$ref": "#/$defs/0"
                        },
                        "changeKindReason": {
                          "$ref": "#/$defs/1"
                        }
                      },
                      "additionalProperties": false,
                      "$defs": {
                        "0": {
                          "minItems": 1,
                          "maxItems": 10,
                          "type": "array",
                          "items": {
                            "type": "string",
                            "enum": [
                              "ui",
                              "service",
                              "migration",
                              "background-job",
                              "logic",
                              "refactor",
                              "docs",
                              "config",
                              "test-only",
                              "no-code-change"
                            ]
                          },
                          "description": "The kind(s) of change this work makes, from the bundled catalog: ui, service, migration, background-job, logic, refactor, docs, config, test-only, no-code-change. A successful close must carry each kind's proof. Re-declaring later keeps the earlier declaration in history."
                        },
                        "1": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 1000,
                          "description": "Why the declared kinds changed or were first declared late. Stored with the declaration."
                        }
                      }
                    }
                  ],
                  "description": "Accepts either a compact positional `row` string or the full keyed args shape."
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
                "name": "work_items:release",
                "description": "Release one OR many work-items (clear assignee / taken_by) so another agent can pick them up. Single: { id }. Many: { ids:[…] } or items:[{ id, harness? }]. `claimHold:true` (both families) ALSO durably parks the item out of claim_next/scheduler:get_next self-select (WI-2797) and requires `claimHoldRelease:{condition,trigger,owner?}`; the writer resolves reachability/evidence from the event ledger. The park survives your session ending, remains claimable by id, and `claimHold:false` clears it.",
                "inputSchema": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "description": "single-release shorthand: the work-item id",
                      "type": "string",
                      "minLength": 1
                    },
                    "ids": {
                      "description": "release many work-items at once (homogeneous)",
                      "minItems": 1,
                      "maxItems": 200,
                      "type": "array",
                      "items": {
                        "type": "string",
                        "minLength": 1
                      }
                    },
                    "items": {
                      "description": "release many, each { id, harness?, claimHold? }",
                      "minItems": 1,
                      "maxItems": 200,
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "string",
                            "minLength": 1
                          },
                          "harness": {
                            "description": "per-item harness (else the batch `harness` default)",
                            "type": "string",
                            "maxLength": 80
                          },
                          "claimHold": {
                            "description": "per-item claim-hold override (else the batch `claimHold` default)",
                            "type": "boolean"
                          },
                          "claimHoldRelease": {
                            "description": "typed release condition required when the effective claimHold is true",
                            "type": "object",
                            "properties": {
                              "condition": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 1000,
                                "description": "the concrete condition that permits this durable park to be reconsidered"
                              },
                              "trigger": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 300,
                                "description": "the exact events:await key that signals the condition may have changed"
                              },
                              "owner": {
                                "description": "accountable condition owner/source; defaults to the parker",
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 200
                              }
                            },
                            "required": [
                              "condition",
                              "trigger"
                            ],
                            "additionalProperties": false
                          },
                          "force": {
                            "description": "per-item override of the batch `force` default",
                            "type": "boolean"
                          },
                          "reason": {
                            "description": "per-item override of the batch `reason` (required when force clears a peer's claim)",
                            "type": "string"
                          }
                        },
                        "required": [
                          "id"
                        ],
                        "additionalProperties": false
                      }
                    },
                    "harness": {
                      "description": "default harness for the inline id / ids / items that omit one",
                      "type": "string",
                      "maxLength": 80
                    },
                    "claimHold": {
                      "description": "default claim-hold for the inline id / every id in `ids` (both families): true excludes the item from claim_next/scheduler:get_next self-select until cleared; false clears a prior hold.",
                      "type": "boolean"
                    },
                    "claimHoldRelease": {
                      "description": "default typed release condition for claimHold:true; reachability/evidence are resolved by the writer",
                      "type": "object",
                      "properties": {
                        "condition": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 1000,
                          "description": "the concrete condition that permits this durable park to be reconsidered"
                        },
                        "trigger": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 300,
                          "description": "the exact events:await key that signals the condition may have changed"
                        },
                        "owner": {
                          "description": "accountable condition owner/source; defaults to the parker",
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 200
                        }
                      },
                      "required": [
                        "condition",
                        "trigger"
                      ],
                      "additionalProperties": false
                    },
                    "force": {
                      "description": "default force for the inline id / every id in `ids`: release even if held by ANOTHER agent. CHECKED override (WI-4198): allowed only when the holder is not live, or you are queen, or you lead the HOLDER's fleet — and a cross-holder force requires `reason` and is audited + notifies holder/owner. Default false: refuses with { error:\"not_holder\", holder } when the caller is not the current holder.",
                      "type": "boolean"
                    },
                    "reason": {
                      "description": "default reason for the inline id / every id in `ids` — REQUIRED when force clears another agent's claim; auto-truncated to 500 chars if longer, then recorded in the audit row/notifications and any durable park.",
                      "type": "string"
                    }
                  },
                  "additionalProperties": false,
                  "x-papercusp-call-constraint": "claimHold:true requires claimHoldRelease { condition, trigger, owner? }; durable parks must declare a typed re-evaluation contract (including per-item overrides and batch defaults)"
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
              },
              {
                "name": "work_items:comment",
                "description": "Comment on one OR many work-items (any kind) in one call. Single: { id, body }. Many: items:[{ id, body, harness? }]. Appends to each item's thread (created on first comment) and notifies its subscribers. Returns { ok, results:[{ ok, id, post? | error }], counts } — correlate by id; a not-found item never fails the rest.",
                "inputSchema": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "description": "single-comment shorthand: the work-item id (use with `body`)",
                      "type": "string",
                      "minLength": 1
                    },
                    "body": {
                      "description": "single-comment shorthand: the comment text (use with `id`)",
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 32000
                    },
                    "comment": {
                      "description": "alias for `body` (EI-10897) — the comment text. Pass either; both-with-different-values is rejected.",
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 32000
                    },
                    "items": {
                      "description": "comment on many work-items at once — each { id, body|comment, harness? }",
                      "minItems": 1,
                      "maxItems": 100,
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "string",
                            "minLength": 1
                          },
                          "body": {
                            "description": "the comment text",
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 32000
                          },
                          "comment": {
                            "description": "alias for `body` — the comment text. Pass either; both-with-different-values is rejected (EI-10897).",
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 32000
                          },
                          "harness": {
                            "description": "per-item harness (else the batch `harness` default)",
                            "type": "string",
                            "maxLength": 80
                          }
                        },
                        "required": [
                          "id"
                        ],
                        "additionalProperties": false
                      }
                    },
                    "harness": {
                      "description": "default harness for the inline id / items that omit one",
                      "type": "string",
                      "maxLength": 80
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
                "name": "work_items:update",
                "description": "Edit one OR many work-items' title/body/severity/kind/found-during/linked feature/parent/goal/plan_item/needsTwoMachineRig/needsHuman; notifies subscribers. Single: { id, …fields }; many: items:[{ id, …fields }]. Returns per-item { ok, id, item? | error }; missing items do not fail the batch. Goal and plan_item are family-agnostic; parent is the duplicate/child relation and null clears it. Other field edits are issue-family-only (bug/change/task); features remain pipeline-owned. Body shrink is rejected unless confirmShrink:true (EI-8497). needsTwoMachineRig toggles payload.needs_2_machine_rig; compatibility input needsHuman:true writes the strict payload.needsOwnerAction gate, while false clears both legacy and strict keys. `payload` shallow-MERGES free-form keys onto an existing item (admission/claim and `_`-prefixed keys refused). (State → work_items:set_state; structural decisions → work_items:amend; tags → work_items:tag; comments → work_items:comment.)",
                "inputSchema": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "description": "single-update shorthand: the work-item id",
                      "type": "string",
                      "minLength": 1
                    },
                    "frozenTests": {
                      "$ref": "#/$defs/0"
                    },
                    "title": {
                      "$ref": "#/$defs/9"
                    },
                    "body": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 8000
                    },
                    "summary": {
                      "$ref": "#/$defs/4"
                    },
                    "severity": {
                      "$ref": "#/$defs/8"
                    },
                    "kind": {
                      "description": "correct a mislabeled work-item kind — bug = broken (auto-implement-eligible), change = desired improvement (human-gated)",
                      "type": "string",
                      "enum": [
                        "bug",
                        "change"
                      ]
                    },
                    "reporterQuestion": {
                      "$ref": "#/$defs/3"
                    },
                    "foundDuring": {
                      "$ref": "#/$defs/7"
                    },
                    "linkedFeatureId": {
                      "anyOf": [
                        {
                          "type": "string",
                          "maxLength": 80
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "parent": {
                      "$ref": "#/$defs/6"
                    },
                    "goal": {
                      "$ref": "#/$defs/5"
                    },
                    "plan_item": {
                      "$ref": "#/$defs/1"
                    },
                    "confirmShrink": {
                      "description": "EI-8497: a `body` edit that would replace a substantial existing body with something far shorter is REJECTED by default (a fat-finger guard — there's no body revision history to recover from a mis-call). Pass true to confirm a genuinely intended drastic shrink.",
                      "type": "boolean"
                    },
                    "needsTwoMachineRig": {
                      "description": "WI-2796: mark (true) or unmark (false) this item as requiring a live ≥2-machine / Hetzner federation rig to work — scheduler:get_next / claim_next then exclude it from single-box self-select instead of letting single-box agents claim-then-release it repeatedly (EI-18151406094317010). Sets payload.needs_2_machine_rig.",
                      "type": "boolean"
                    },
                    "needsHuman": {
                      "description": "Compatibility input for the owner-action gate: true writes payload.needsOwnerAction=true and removes legacy payload.needsHuman; false unsets BOTH keys and re-admits the row. Reserve true for a genuine credential, physical-device, or external-service action only — product decisions use agent review.",
                      "type": "boolean"
                    },
                    "payload": {
                      "$ref": "#/$defs/2"
                    },
                    "items": {
                      "description": "update many work-items at once — each { id, …fields }. A top-level field (title/body/severity/kind/foundDuring/linkedFeatureId/parent/goal/plan_item/harness) is the DEFAULT applied to every item that omits its own (EI-7639) — pass it once instead of repeating it per item.",
                      "minItems": 1,
                      "maxItems": 200,
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "string",
                            "minLength": 1
                          },
                          "harness": {
                            "description": "per-item harness (else the batch `harness` default)",
                            "type": "string",
                            "maxLength": 80
                          },
                          "frozenTests": {
                            "$ref": "#/$defs/0"
                          },
                          "title": {
                            "$ref": "#/$defs/9"
                          },
                          "body": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 8000
                          },
                          "summary": {
                            "$ref": "#/$defs/4"
                          },
                          "severity": {
                            "$ref": "#/$defs/8"
                          },
                          "kind": {
                            "description": "correct a mislabeled work-item kind — bug = broken (auto-implement-eligible), change = desired improvement (human-gated)",
                            "type": "string",
                            "enum": [
                              "bug",
                              "change"
                            ]
                          },
                          "reporterQuestion": {
                            "$ref": "#/$defs/3"
                          },
                          "foundDuring": {
                            "$ref": "#/$defs/7"
                          },
                          "linkedFeatureId": {
                            "anyOf": [
                              {
                                "type": "string",
                                "maxLength": 80
                              },
                              {
                                "type": "null"
                              }
                            ]
                          },
                          "parent": {
                            "$ref": "#/$defs/6"
                          },
                          "goal": {
                            "$ref": "#/$defs/5"
                          },
                          "plan_item": {
                            "$ref": "#/$defs/1"
                          },
                          "confirmShrink": {
                            "description": "EI-8497: a `body` edit that would replace a substantial existing body with something far shorter is REJECTED by default (a fat-finger guard — there's no body revision history to recover from a mis-call). Pass true to confirm a genuinely intended drastic shrink.",
                            "type": "boolean"
                          },
                          "needsTwoMachineRig": {
                            "description": "WI-2796: mark (true) or unmark (false) this item as requiring a live ≥2-machine / Hetzner federation rig to work — scheduler:get_next / claim_next then exclude it from single-box self-select instead of letting single-box agents claim-then-release it repeatedly (EI-18151406094317010). Sets payload.needs_2_machine_rig.",
                            "type": "boolean"
                          },
                          "needsHuman": {
                            "description": "Compatibility input for the owner-action gate: true writes payload.needsOwnerAction=true and removes legacy payload.needsHuman; false unsets BOTH keys and re-admits the row. Reserve true for a genuine credential, physical-device, or external-service action only — product decisions use agent review.",
                            "type": "boolean"
                          },
                          "payload": {
                            "$ref": "#/$defs/2"
                          }
                        },
                        "required": [
                          "id"
                        ],
                        "additionalProperties": false
                      }
                    },
                    "harness": {
                      "description": "default harness for the inline id / items that omit one",
                      "type": "string",
                      "maxLength": 80
                    }
                  },
                  "additionalProperties": false,
                  "$defs": {
                    "0": {
                      "description": "Opted-in frozenTests: pilot only. Register an independently authored manual test-only evidence binding plus red calibration; use alone. Re-freeze requires a named Decision and expectedRevision.",
                      "type": "object",
                      "properties": {
                        "bindingId": {
                          "type": "integer",
                          "exclusiveMinimum": 0,
                          "maximum": 9007199254740991,
                          "description": "Independent author's current manual spec binding; measurement sourcePaths and testPaths must be exactly the frozen tests."
                        },
                        "redRunIds": {
                          "minItems": 1,
                          "maxItems": 32,
                          "type": "array",
                          "items": {
                            "type": "integer",
                            "exclusiveMinimum": 0,
                            "maximum": 9007199254740991
                          }
                        },
                        "expectedRevision": {
                          "type": "integer",
                          "minimum": 0,
                          "maximum": 9007199254740991
                        },
                        "decisionId": {
                          "description": "Required for re-freeze: Decision with a frozen-tests JSON fence naming itemId, fromRevision, toRevision, previousBindingId, bindingId and reason.",
                          "type": "string",
                          "pattern": "^D-\\d+$"
                        }
                      },
                      "required": [
                        "bindingId",
                        "redRunIds",
                        "expectedRevision"
                      ],
                      "additionalProperties": false
                    },
                    "1": {
                      "description": "plan item this existing work-item implements (for example { slug:\"my-plan\", item:\"P-003\" }); stamps payload.plan_item so plan-scoped fleet lanes can admit it and writes the same coverage edge as work_items:create. Pass null to CLEAR the stamp when it asserts something untrue (the item does not implement that plan item) — this removes the payload key and retracts the coverage edge, releasing the item from the plan-item lane-sync hold and the sibling-close machinery.",
                      "anyOf": [
                        {
                          "type": "object",
                          "properties": {
                            "slug": {
                              "type": "string",
                              "minLength": 1
                            },
                            "item": {
                              "type": "string",
                              "minLength": 1
                            }
                          },
                          "required": [
                            "slug",
                            "item"
                          ],
                          "additionalProperties": false
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "2": {
                      "description": "MERGE these keys into payload (shallow jsonb merge — sibling keys are preserved, never replaced). For durable per-item metadata a plan or rubric rules must live on the artifact. Admission/claim keys (plan_item, needs_2_machine_rig, needsOwnerAction, needsHuman, lane, claim_hold_*), externalBlockers (use work_items:set_blocker) and `_`-prefixed internal keys are REFUSED — use their dedicated args, which also apply the coverage edge and legacy-key unsets a bare merge would skip.",
                      "type": "object",
                      "propertyNames": {
                        "type": "string"
                      },
                      "additionalProperties": {}
                    },
                    "3": {
                      "description": "Ask the end-user reporter one follow-up question. Only the current fixer may ask; actor/id/time are server-stamped, text is redacted, and retry is idempotent. Use alone, without other edits. The reporter replies from their install.",
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 4000
                    },
                    "4": {
                      "description": "alias for `body` — the item’s main text (work_items:get/create name it `summary`). Pass either; both-with-different-values is rejected (WI-4492).",
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 8000
                    },
                    "5": {
                      "description": "goal id to adopt this work-item into, or null to clear its goal attribution",
                      "anyOf": [
                        {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 200
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "6": {
                      "description": "parent work-item id for duplicate/child relationships; null clears the edge",
                      "anyOf": [
                        {
                          "type": "string",
                          "maxLength": 80
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "7": {
                      "anyOf": [
                        {
                          "type": "string",
                          "description": "Free text — auto-truncated to 120 chars if longer."
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "8": {
                      "type": "string",
                      "enum": [
                        "critical",
                        "major",
                        "minor",
                        "nit"
                      ]
                    },
                    "9": {
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
                  "papercusp/servingGeneration": "serving-generation-v1:a528040778992a8ce2dda4696ff0affe43345629ae38c3e3ff7732a35db2389c"
                }
              },
              {
                "name": "work_items:checkpoint",
                "description": "Write or clear work-item checkpoints. Single: `{ id, checkpoint? }`; many: `items:[{ id, checkpoint?, harness? }]`. Writes replace by default; `append:true` preserves the full prior narrative only when combined text fits the cap. Writes verify-read; a big shrink keeps prior under your note; peer-held/terminal-item writes are refused while explicit clears remain allowed. `rowsMode:\"merge\"` adds check rows while replacing the body; `\"replace\"` retires rows. Full body+rows replacement requires `append:false, rowsMode:\"replace\", confirmShrink:true, retireIds:[...]`.",
                "inputSchema": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "description": "single shorthand: the work-item id (use with `checkpoint`)",
                      "type": "string",
                      "minLength": 1
                    },
                    "unchanged": {
                      "description": "single shorthand default for `unchanged`; also the items[] default. ATTEST that the stored checkpoint is still current instead of rewriting it. Requires `contentHash`. Do not send `checkpoint`, `did`/`left`/`insight`/`next`, `clear`, `append`, `checks`, or `dependsOn` with `unchanged:true`; omit `unchanged` when writing a new body. Conflicting fields return `attestation_conflicting_args`.",
                      "x-papercusp-call-constraint": "when `unchanged:true` => `contentHash` required; `checkpoint`, `clear:true`, `append:true`, `checks`, `retireIds`, and `dependsOn` forbidden (violations return `attestation_conflicting_args`); `confirmRetire` cannot authorize a row mutation.",
                      "type": "boolean"
                    },
                    "contentHash": {
                      "description": "single shorthand default for `contentHash`; also the items[] default. Required with `unchanged`.",
                      "type": "string",
                      "minLength": 6,
                      "maxLength": 64
                    },
                    "checkpoint": {
                      "description": "single shorthand: compressed in-flight state; null or clear:true ⇒ clear; omission requires `checks`, `dependsOn`, `learned`, or `learnedLevel` as a metadata-only patch; blank string requires confirmClear:true; accepts the structured { did, left, insight, next } carry-note shape and loop aliases. `checks` is a sibling argument, not a field inside this object.",
                      "$ref": "#/$defs/work-items-checkpoint-body-v1"
                    },
                    "note": {
                      "description": "loop:checkpoint compatibility alias for the single shorthand checkpoint; explicit checkpoint wins.",
                      "anyOf": [
                        {
                          "$ref": "#/$defs/6"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "did": {
                      "$ref": "#/$defs/3"
                    },
                    "left": {
                      "$ref": "#/$defs/3"
                    },
                    "insight": {
                      "$ref": "#/$defs/3"
                    },
                    "next": {
                      "$ref": "#/$defs/3"
                    },
                    "keyInsight": {
                      "description": "compatibility alias for insight; explicit insight wins.",
                      "anyOf": [
                        {
                          "$ref": "#/$defs/6"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "nextAction": {
                      "description": "compatibility alias for next; explicit next wins.",
                      "anyOf": [
                        {
                          "$ref": "#/$defs/6"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "goal": {
                      "description": "compatibility alias for next; explicit next and nextAction win.",
                      "anyOf": [
                        {
                          "$ref": "#/$defs/6"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "workItem": {
                      "description": "loop:checkpoint compatibility alias for id; when both are set they must identify the same item.",
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 120
                    },
                    "clear": {
                      "description": "single shorthand default for `clear`; explicitly clear the checkpoint body (equivalent to checkpoint:null).",
                      "type": "boolean"
                    },
                    "confirmClear": {
                      "description": "single shorthand default for `confirmClear`; authorize checkpoint:\"\" or whitespace-only text as an intentional clear.",
                      "type": "boolean"
                    },
                    "items": {
                      "description": "checkpoint many work-items at once — each { id, checkpoint?, harness?, append? }",
                      "minItems": 1,
                      "maxItems": 100,
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "string",
                            "minLength": 1,
                            "description": "the work-item id to checkpoint"
                          },
                          "checkpoint": {
                            "description": "compressed in-flight state; null or clear:true ⇒ clear; omission requires `checks`, `dependsOn`, `learned`, or `learnedLevel` as a metadata-only patch; blank string requires confirmClear:true; accepts the structured { did, left, insight, next } carry-note shape and loop aliases",
                            "$ref": "#/$defs/work-items-checkpoint-body-v1"
                          },
                          "did": {
                            "$ref": "#/$defs/work-items-checkpoint-carry-alias-v1"
                          },
                          "left": {
                            "$ref": "#/$defs/work-items-checkpoint-carry-alias-v1"
                          },
                          "insight": {
                            "$ref": "#/$defs/work-items-checkpoint-carry-alias-v1"
                          },
                          "next": {
                            "$ref": "#/$defs/work-items-checkpoint-carry-alias-v1"
                          },
                          "clear": {
                            "description": "explicitly clear the checkpoint body. Equivalent to checkpoint:null and rejected with a non-blank checkpoint.",
                            "type": "boolean"
                          },
                          "confirmClear": {
                            "description": "EI-21020695928840897: authorize a blank-string checkpoint clear. Without this, checkpoint:\"\" (or whitespace-only text) is rejected before the store is touched.",
                            "type": "boolean"
                          },
                          "harness": {
                            "description": "per-item harness (else the batch `harness` default / ctx / item lookup)",
                            "type": "string",
                            "maxLength": 80
                          },
                          "append": {
                            "description": "EI-9036: append `checkpoint` to the stored note with `---`; supplied checks union unless `rowsMode:\"replace\"` (rows only). Omit checkpoint with checks for a body-preserving patch; otherwise a non-blank checkpoint is required (append + clear is rejected). At 32000 chars, prior-prose loss refuses unless `confirmShrink:true`; carried checks remain, and row overflow reports omissions or refuses checks-only writes.",
                            "type": "boolean"
                          },
                          "confirmShrink": {
                            "description": "Confirm intentional loss of prior content: replaces may shrink substantial notes; appends may evict prior prose at the cap.",
                            "type": "boolean"
                          },
                          "rowsMode": {
                            "description": "Controls CHECK ROWS only. `merge` (default) unions rows; `replace` applies rows. `retireIds` requires explicit `rowsMode:'replace'`. With `append:true` + `rowsMode:'replace'`, `retireIds` are required for retired rows; `confirmRetire:true` alone is not enough. Full replacement: `append:false, rowsMode:'replace', confirmShrink:true, retireIds:[...]`. Absent `retireIds`, omitted rows survive. `confirmShrink` preserves >50% shrinks.",
                            "type": "string",
                            "enum": [
                              "replace",
                              "merge"
                            ]
                          },
                          "confirmRetire": {
                            "description": "Compatibility field. Does not authorize omitted-row retirement or cap eviction; use exact `retireIds`.",
                            "type": "boolean"
                          },
                          "retireIds": {
                            "description": "With rowsMode:'replace', name the exact carried row IDs (or claim text for rows without IDs) to retire. Every dropped row must be named and every name must match a dropped row, or the write refuses. Read current IDs with work_items:get { checksOnly:true }.",
                            "x-papercusp-call-constraint": "Requires effective `rowsMode:'replace'`; an `items[]` entry overrides the root setting, and omitted `rowsMode` defaults to `'merge'`.",
                            "maxItems": 24,
                            "type": "array",
                            "items": {
                              "type": "string",
                              "minLength": 1
                            }
                          },
                          "dependsOn": {
                            "$ref": "#/$defs/0"
                          },
                          "checks": {
                            "$ref": "#/$defs/work-items-checks-v1"
                          },
                          "learned": {
                            "$ref": "#/$defs/5"
                          },
                          "learnedLevel": {
                            "$ref": "#/$defs/4"
                          },
                          "unchanged": {
                            "description": "P-007/R-06: ATTEST the stored checkpoint is still current instead of rewriting it (refreshes freshness, body byte-identical). REQUIRES `contentHash` (from a prior write's result or work_items:get); mutually exclusive with checkpoint/clear/append/checks/dependsOn. BOUNDED: refuses with attestation_hash_mismatch, attestation_state_changed (item row moved after the body) or attestation_exhausted (chain/age budget spent) — then write a real checkpoint; a genuine write resets the budget.",
                            "type": "boolean"
                          },
                          "contentHash": {
                            "description": "The stored checkpoint hash you are attesting to (the `contentHash` a prior write returned). Required with `unchanged:true` and ignored otherwise. Binds the attestation to a body you have actually read, so a checkpoint someone else replaced fails the check instead of being silently re-blessed.",
                            "type": "string",
                            "minLength": 6,
                            "maxLength": 64
                          },
                          "changeKinds": {
                            "$ref": "#/$defs/2"
                          },
                          "changeKindReason": {
                            "$ref": "#/$defs/7"
                          }
                        },
                        "required": [
                          "id"
                        ],
                        "additionalProperties": false
                      }
                    },
                    "harness": {
                      "description": "default harness for the inline id / items that omit one",
                      "type": "string",
                      "maxLength": 80
                    },
                    "append": {
                      "description": "single shorthand default for `append` (EI-9036): join `checkpoint` onto the existing stored checkpoint instead of replacing it, and UNION supplied `checks` onto the carried set instead of replacing them (EI-19944669306930709). With `checks` and no `checkpoint`, this is an additive checks-only patch. With explicit `rowsMode:'replace'`, any appended-body write that retires checks requires exact `retireIds`, even with `confirmRetire:true`. Also the default applied to any `items[]` entry that omits its own `append`.",
                      "type": "boolean"
                    },
                    "confirmShrink": {
                      "description": "single shorthand default for `confirmShrink` (EI-18140632570924965), also the items[] default.",
                      "type": "boolean"
                    },
                    "rowsMode": {
                      "description": "single shorthand default for `rowsMode`; also the items[] default. This controls CHECK ROWS only, not the body. `merge` unions supplied checks without appending the body. With `append:true` + `rowsMode:'replace'`, `retireIds` are required for any retired row; `confirmRetire:true` alone is not sufficient. A complete body+rows replacement is append:false, rowsMode:'replace', confirmShrink:true, retireIds:[...]. Without retireIds, omitted rows survive.",
                      "type": "string",
                      "enum": [
                        "replace",
                        "merge"
                      ]
                    },
                    "confirmRetire": {
                      "description": "single shorthand compatibility field, also the items[] default. Cannot authorize omission or cap eviction; retirement requires exact `retireIds`.",
                      "type": "boolean"
                    },
                    "retireIds": {
                      "description": "single shorthand default for `retireIds`; also the items[] default. Name exactly the carried row ids (legacy claim text for rows without ids) a rowsMode:'replace' should retire. Required for every retirement; the write refuses on any mismatch.",
                      "x-papercusp-call-constraint": "Requires effective `rowsMode:'replace'`; an `items[]` entry overrides the root setting, and omitted `rowsMode` defaults to `'merge'`.",
                      "maxItems": 24,
                      "type": "array",
                      "items": {
                        "type": "string",
                        "minLength": 1
                      }
                    },
                    "checks": {
                      "$ref": "#/$defs/work-items-checks-v1"
                    },
                    "dependsOn": {
                      "$ref": "#/$defs/0"
                    },
                    "learned": {
                      "$ref": "#/$defs/5"
                    },
                    "learnedLevel": {
                      "$ref": "#/$defs/4"
                    },
                    "changeKinds": {
                      "$ref": "#/$defs/2"
                    },
                    "changeKindReason": {
                      "$ref": "#/$defs/7"
                    }
                  },
                  "additionalProperties": false,
                  "x-papercusp-call-constraint": "With `items[]`, omit root-level `checkpoint`, `note`, `did`, `left`, `insight`, `next`, `keyInsight`, `nextAction`, `goal`, and `workItem`; put checkpoint content or per-item carry aliases on each entry. Root-level `confirmShrink`, `append`, `rowsMode`, `confirmRetire`, and `retireIds` remain defaults for entries.",
                  "$defs": {
                    "0": {
                      "description": "P-007 freshness: what this checkpoint is derived FROM, as `kind:ref` tags — supported kinds: file, work-item, plan (e.g. \"file:packages/operator-core/lib/x.ts\", \"work-item:WI-6198\", \"plan:my-plan-slug\"). Each is resolved to a version token and stamped NOW, so a later reader is told WHICH dependency moved instead of guessing from the checkpoint's age. Declaring them makes an OLD checkpoint readable as fresh when nothing moved, and — the case no age threshold can catch — a SECONDS-OLD one as stale when a PEER changed a file it depends on. Omit to keep the previous declaration; pass [] to clear it.",
                      "maxItems": 24,
                      "type": "array",
                      "items": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 300
                      }
                    },
                    "1": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 160,
                      "description": "Exact projected-tool-registry revision for this target. Writer-only `live` is expanded to the current target revision before validation; persisted and replayed probes contain the concrete revision."
                    },
                    "2": {
                      "minItems": 1,
                      "maxItems": 10,
                      "type": "array",
                      "items": {
                        "type": "string",
                        "enum": [
                          "ui",
                          "service",
                          "migration",
                          "background-job",
                          "logic",
                          "refactor",
                          "docs",
                          "config",
                          "test-only",
                          "no-code-change"
                        ]
                      },
                      "description": "The kind(s) of change this work makes, from the bundled catalog: ui, service, migration, background-job, logic, refactor, docs, config, test-only, no-code-change. A successful close must carry each kind's proof. Re-declaring later keeps the earlier declaration in history."
                    },
                    "3": {
                      "description": "loop:checkpoint compatibility field for the single shorthand checkpoint.",
                      "anyOf": [
                        {
                          "$ref": "#/$defs/6"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "4": {
                      "description": "which level `learned` belongs to — write at the level you are working at. Default 'work_item' (the level 94% of items have); a level this item lacks falls back to the most specific one it has.",
                      "type": "string",
                      "enum": [
                        "work_item",
                        "plan",
                        "goal"
                      ]
                    },
                    "5": {
                      "description": "a durable lesson to post on the effort thread in this same call — the part of your note a future claimant needs. Defaults to this work-item; pass learnedLevel to attach it where it belongs.",
                      "type": "string",
                      "maxLength": 4000
                    },
                    "6": {
                      "type": "string",
                      "maxLength": 32000
                    },
                    "7": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 1000,
                      "description": "Why the declared kinds changed or were first declared late. Stored with the declaration."
                    },
                    "8": {
                      "$ref": "#/$defs/continuity-predicate-v1"
                    },
                    "work-items-checkpoint-body-v1": {
                      "anyOf": [
                        {
                          "anyOf": [
                            {
                              "$ref": "#/$defs/6"
                            },
                            {
                              "type": "object",
                              "properties": {
                                "did": {
                                  "$ref": "#/$defs/6"
                                },
                                "left": {
                                  "$ref": "#/$defs/6"
                                },
                                "insight": {
                                  "$ref": "#/$defs/6"
                                },
                                "next": {
                                  "$ref": "#/$defs/6"
                                },
                                "keyInsight": {
                                  "$ref": "#/$defs/6"
                                },
                                "nextAction": {
                                  "$ref": "#/$defs/6"
                                },
                                "goal": {
                                  "$ref": "#/$defs/6"
                                }
                              },
                              "additionalProperties": false
                            }
                          ]
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "work-items-checkpoint-carry-alias-v1": {
                      "anyOf": [
                        {
                          "$ref": "#/$defs/6"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "work-items-checks-v1": {
                      "description": "`checks` is a sibling of `checkpoint`, never nested inside it: use root-level `checks` beside `checkpoint` for a single write, or `items[n].checks` beside `items[n].checkpoint` in a batch. Carried CHECKS — claims about EXTERNAL state paired with the probe that falsifies them, rendered as a `## Checks` section every time this checkpoint is re-injected. Put hash/id/timestamp/state expectations HERE rather than in checkpoint prose, so the probe travels with the claim and a successor can tell an ASSERTED claim from a VERIFIED one. Carry-forward semantics: OMITTED preserves the existing rows (a plain rewrite never silently drops them) and [] preserves them. With `append: true` or `rowsMode:'merge'` a supplied list is UNIONED onto the carried set (supplied wins on matching claim text), but capped at 12: an unconfirmed checks-only overflow refuses atomically before it can drop rows; `confirmRetire:true` cannot authorize cap eviction. A body-bearing append/merge still stores the body and every carried row, admits supplied rows only into vacant slots, and returns `checksNotRetained`/`checksNotRetainedRows` for supplied rows that did not fit. Retire stale rows with a plain replace first, or append without `checks` to leave the carried set untouched. WITHOUT append, `rowsMode:'merge'` (the default) unions the supplied list with the carried set; use explicit `rowsMode:'replace'` plus exact `retireIds` to close individual carried rows. Without retireIds, omitted rows survive. A supplied row whose claim text matches a stored one inherits that row's recheck/verified/contested/sinceMs when you omit them, so re-sending a claim never loses its evidence. Supplying `verified` clears an inherited `contested` and vice versa — they are two renderings of ONE evidence slot, not independent fields — and under merge, use `replaces` with the carried row id or exact old claim to re-word an id-less row at the cap without treating it as a new addition. Unmatched refs are reported and treated as additions. evidence that contradicts itself (for example \"STILL RUNNING\") is auto-downgraded to ⚠ CONTESTED rather than rendering as ✓ VERIFIED. Rows dropped come back as `checksDropped`; additive-cap refusals also include the exact stored rows as `checksDroppedRows` with sanitized ids. A bare string row is accepted as shorthand for `{ claim: <that string> }`.",
                      "maxItems": 12,
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "description": "Stable id for this row (e.g. 'gate-green'), independent of wording. Lets you RE-WORD the claim without losing its evidence/age, and is what rowsMode:'merge' upserts on. Soft cap: 40 chars; longer inputs are accepted and truncated with a reported repair. Hard input backstop: 160 chars; larger inputs are rejected. Omitted ⇒ identity is the claim text.",
                            "type": "string",
                            "maxLength": 160,
                            "x-soft-maxLength": 40
                          },
                          "replaces": {
                            "description": "Edit a carried row in place: its [#id] or exact claim. Keeps its evidence/age; the row gains a stable id. Unmatched refs are reported.",
                            "type": "string",
                            "maxLength": 4000
                          },
                          "claim": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 2000,
                            "x-soft-maxLength": 500,
                            "description": "The claim about external state, stated concretely. Soft cap: 500 chars; longer values are accepted and truncated with a reported repair. Hard input backstop: 2000 chars; larger values are rejected."
                          },
                          "sinceMs": {
                            "description": "Optional epoch-millisecond timestamp for when this claim began standing.",
                            "type": "number"
                          },
                          "recheck": {
                            "type": "string",
                            "maxLength": 1200,
                            "x-soft-maxLength": 300,
                            "description": "The concrete probe that would falsify the claim. Soft cap: 300 chars; longer values are accepted and truncated with a reported repair. Hard input backstop: 1200 chars; larger values are rejected."
                          },
                          "falsifier": {
                            "type": "string",
                            "maxLength": 1200,
                            "x-soft-maxLength": 300,
                            "description": "Result that would mean this claim is FALSE (as facts:assert `falsifier`). A probe says how to look; this says what refutes it. Soft cap: 300 chars; longer values are accepted and truncated with a reported repair. Hard input backstop: 1200 chars; larger values are rejected."
                          },
                          "sampleAdequate": {
                            "description": "`false` = probed, but the sample could not discriminate the claim from its negation; renders ? not ✓.",
                            "type": "boolean"
                          },
                          "verified": {
                            "type": "string",
                            "maxLength": 1200,
                            "x-soft-maxLength": 300,
                            "description": "The EVIDENCE STRING (what you actually observed). For compatibility, boolean `true`/`false` is normalized before validation: `true` without evidence and `false` both remain ? PREDICTED. Presence of an evidence string renders the row ✓ VERIFIED; omission renders ? PREDICTED, telling a successor to run `recheck` before relying on the claim. Soft cap: 300 chars; longer values are accepted and truncated with a reported repair. Hard input backstop: 1200 chars; larger values are rejected."
                          },
                          "observed": {
                            "type": "string",
                            "maxLength": 1200,
                            "x-soft-maxLength": 300,
                            "description": "Observed context that does not affirm the claim. It renders on a ? PREDICTED row so the context survives without acquiring verification authority. Soft cap: 300 chars; longer values are accepted and truncated with a reported repair. Hard input backstop: 1200 chars; larger values are rejected."
                          },
                          "testResult": {
                            "type": "string",
                            "maxLength": 1200,
                            "x-soft-maxLength": 300,
                            "description": "Compatibility alias for completion-style `testResult`; normalized to the canonical `verified` evidence string before storage. Prefer `verified`. Soft cap: 300 chars; longer values are accepted and truncated with a reported repair. Hard input backstop: 1200 chars; larger values are rejected."
                          },
                          "ok": {
                            "description": "Compatibility alias for boolean check results: `{ ok: true|false }` is normalized to the `verified` evidence slot before storage. A bare true or false remains PREDICTED; pair true with `evidence` to render VERIFIED. Prefer the canonical `verified` evidence string.",
                            "type": "boolean"
                          },
                          "contested": {
                            "type": "string",
                            "maxLength": 1200,
                            "x-soft-maxLength": 300,
                            "description": "Evidence that was supplied as verification but contradicts it (for example, \"STILL RUNNING\"). Rendered with ⚠ CONTESTED and never upgraded to VERIFIED; re-check before relying on the claim. Soft cap: 300 chars; longer values are accepted and truncated with a reported repair. Hard input backstop: 1200 chars; larger values are rejected."
                          },
                          "probe": {
                            "description": "Optional schema-versioned, read-only executable probe. Validated against the live tool/cell contract before any checkpoint bytes persist; use `schemaRevision:\"live\"` as a writer-only shorthand for the current target revision; persisted probes retain the concrete revision; `recheck` remains the human explanation.",
                            "oneOf": [
                              {
                                "type": "object",
                                "properties": {
                                  "kind": {
                                    "type": "string",
                                    "const": "tool"
                                  },
                                  "tool": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 200,
                                    "description": "Exact direct projected-tool name. Only directly invoked read-only tools may be persisted; indirect/meta surfaces such as `dev:pg_query`, `tools:invoke`, `code:run`, `recipes:run`, `capability:*`, and `computer:*` are rejected."
                                  },
                                  "args": {
                                    "default": {},
                                    "type": "object",
                                    "propertyNames": {
                                      "type": "string"
                                    },
                                    "additionalProperties": {}
                                  },
                                  "projection": {
                                    "type": "object",
                                    "additionalProperties": true,
                                    "description": "matches any object value"
                                  },
                                  "schemaRevision": {
                                    "$ref": "#/$defs/1"
                                  },
                                  "expect": {
                                    "$ref": "#/$defs/8"
                                  }
                                },
                                "required": [
                                  "kind",
                                  "tool",
                                  "args",
                                  "schemaRevision",
                                  "expect"
                                ],
                                "additionalProperties": false
                              },
                              {
                                "type": "object",
                                "properties": {
                                  "kind": {
                                    "type": "string",
                                    "const": "state-cell"
                                  },
                                  "cell": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 120
                                  },
                                  "as": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 200
                                  },
                                  "schemaRevision": {
                                    "$ref": "#/$defs/1"
                                  },
                                  "expect": {
                                    "$ref": "#/$defs/8"
                                  }
                                },
                                "required": [
                                  "kind",
                                  "cell",
                                  "schemaRevision",
                                  "expect"
                                ],
                                "additionalProperties": false
                              },
                              {
                                "type": "object",
                                "properties": {
                                  "kind": {
                                    "type": "string",
                                    "const": "sql"
                                  },
                                  "sql": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 4000,
                                    "description": "One read-only SELECT or WITH…SELECT, run through dev:pg_query: READ ONLY transaction, row cap and statement timeout are always applied, and a write is refused without changing any row. `expect` reads the dev:pg_query result, e.g. { path: \"$.rows[0].n\", op: \"gte\", value: 1 }."
                                  },
                                  "maxRows": {
                                    "default": 50,
                                    "description": "Row cap passed to dev:pg_query (default 50).",
                                    "type": "integer",
                                    "exclusiveMinimum": 0,
                                    "maximum": 2000
                                  },
                                  "allowUnscoped": {
                                    "description": "Forwarded to dev:pg_query: allow a deliberate cross-tenant read of a tenant-scoped table.",
                                    "type": "boolean"
                                  },
                                  "schemaRevision": {
                                    "$ref": "#/$defs/1"
                                  },
                                  "expect": {
                                    "$ref": "#/$defs/8"
                                  }
                                },
                                "required": [
                                  "kind",
                                  "sql",
                                  "maxRows",
                                  "schemaRevision",
                                  "expect"
                                ],
                                "additionalProperties": false
                              }
                            ]
                          },
                          "tool": {
                            "description": "Compatibility field for a flattened tool probe.",
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 200
                          },
                          "args": {
                            "description": "Compatibility field for flattened tool-probe arguments.",
                            "type": "object",
                            "propertyNames": {
                              "type": "string"
                            },
                            "additionalProperties": {}
                          },
                          "projection": {
                            "type": "object",
                            "additionalProperties": true,
                            "description": "Compatibility field for a flattened tool-probe projection."
                          },
                          "schemaRevision": {
                            "description": "Compatibility field for a flattened probe revision.",
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 160
                          },
                          "expect": {
                            "description": "Compatibility field for a flattened probe predicate.",
                            "$ref": "#/$defs/continuity-predicate-v1"
                          },
                          "cell": {
                            "description": "Compatibility field for a flattened state-cell probe.",
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 120
                          },
                          "as": {
                            "description": "Compatibility field for a flattened state-cell reader.",
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 200
                          }
                        },
                        "required": [
                          "claim"
                        ],
                        "additionalProperties": false
                      }
                    },
                    "continuity-predicate-v1": {
                      "type": "object",
                      "properties": {
                        "path": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 240,
                          "description": "Dot/bracket path into the JSON result; use \"$\" for the root value."
                        },
                        "op": {
                          "type": "string",
                          "enum": [
                            "exists",
                            "eq",
                            "ne",
                            "gt",
                            "gte",
                            "lt",
                            "lte"
                          ],
                          "description": "Predicate operation. `exists` checks presence and MUST omit `value`; comparison operations require a scalar `value`."
                        },
                        "value": {
                          "description": "Expected scalar for comparison operations; omit this field when `op` is `exists`.",
                          "anyOf": [
                            {
                              "type": "string",
                              "maxLength": 1000
                            },
                            {
                              "type": "number"
                            },
                            {
                              "type": "boolean"
                            },
                            {
                              "type": "null"
                            }
                          ]
                        }
                      },
                      "required": [
                        "path",
                        "op"
                      ],
                      "additionalProperties": false
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
              },
              {
                "name": "work_items:claim_next",
                "description": "Self-select the next work-item. This compatibility wrapper honors fleet scope through the same selector as scheduler:get_next. Outside a fleet, disabling scheduler claim-specs degrades to legacy oldest-first SKIP LOCKED; a fleet MEMBER never takes that fallback. Returns the claimed item or a self-describing miss; a scoped miss carries windDown:true.",
                "inputSchema": {
                  "type": "object",
                  "properties": {
                    "harness": {
                      "type": "string",
                      "minLength": 1
                    },
                    "kind": {
                      "description": "active feature-family narrowing; retired 'chunk' rows are never self-selected",
                      "type": "string",
                      "enum": [
                        "feature"
                      ]
                    },
                    "assignee": {
                      "description": "default: you (also resolves the literal \"self\" to you)",
                      "type": "string",
                      "maxLength": 120
                    },
                    "ignoreContextPressure": {
                      "description": "WI-5940 escape hatch: proceed even though your CACHED context-pressure bucket reads critical (self-pull only). Pass true only when your OWN live gauge contradicts it.",
                      "type": "boolean"
                    },
                    "states": {
                      "description": "claimable states — subset of ['open','failing'] (default ['open'] — the unified claimable token for BOTH families; feature `todo` retired). 'blocked'/'cursed' are resolver-owned floors (blocked items are leader-triage-only) and terminal states are settled — neither is requestable (D-002 / WI-1912).",
                      "maxItems": 20,
                      "type": "array",
                      "items": {
                        "type": "string",
                        "enum": [
                          "open",
                          "failing"
                        ]
                      }
                    },
                    "count": {
                      "description": "How many of the OLDEST unclaimed items to claim (default 1, max 25). >1 loops the same race-free SKIP-LOCKED claim path N times, stopping at the first miss — so you may get FEWER than `count` when the queue runs dry. count>1 returns { ok, claimed: [...] }; omitted/1 keeps the single-item { ok, workItem } shape (backward-compatible).",
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 25
                    },
                    "rigAvailable": {
                      "description": "WI-2796: pass true ONLY when you actually have/coordinate a live ≥2-machine or Hetzner federation rig. Default (false/omitted): items tagged payload.needs_2_machine_rig are excluded from self-select — a single-box caller cannot execute them anyway, and claiming-then-releasing one is pure recycle churn. A rig-equipped fleet passes true to see them.",
                      "type": "boolean"
                    }
                  },
                  "required": [
                    "harness"
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
                "name": "scheduler:get_next",
                "description": "Atomically claim the next eligible item under global floors plus the stored claim-spec filter/rank (SKIP LOCKED). A fleet member without an inherited spec fails closed (windDown:true); a non-fleet caller without a declared plan and without a spec uses warned default ordering, while a plan-bound caller fails closed. Returns the claimed item or a diagnosed miss. A successful claim also declares the caller's WI-/EI- intent; specId and revision are result provenance, not request arguments.",
                "inputSchema": {
                  "type": "object",
                  "properties": {
                    "harness": {
                      "description": "Harness to pull from. OPTIONAL — defaults to the session's own harness when it has exactly one. Pass it explicitly only to pull from a DIFFERENT harness than the session is scoped to.",
                      "type": "string",
                      "minLength": 1
                    },
                    "heldPaths": {
                      "description": "paths you already hold open — the affinity rank-term input (default: none)",
                      "maxItems": 500,
                      "type": "array",
                      "items": {
                        "type": "string"
                      }
                    },
                    "states": {
                      "description": "claimable states — subset of ['open','failing']. Omit to inherit your claim spec's own `states` (drain-claim-spec-hardening-2026-07-13 D-002/EI-11300 — a fleet leader sets it once via scheduler:set_claim_spec, every member inherits it), else ['open']. `open` is the unified claimable token for BOTH families now (feature `todo` retired). Passing this EXPLICITLY always wins over the spec. 'blocked'/'cursed' are resolver-owned floors (blocked items are leader-triage-only) and terminal states are settled — neither is requestable (D-002 / WI-1912).",
                      "maxItems": 20,
                      "type": "array",
                      "items": {
                        "type": "string",
                        "enum": [
                          "open",
                          "failing"
                        ]
                      }
                    },
                    "rigAvailable": {
                      "description": "WI-2796: pass true ONLY when you actually have/coordinate a live ≥2-machine or Hetzner federation rig. Default (false/omitted): items tagged payload.needs_2_machine_rig are excluded — a single-box caller cannot execute them anyway.",
                      "type": "boolean"
                    },
                    "ignoreContextPressure": {
                      "description": "WI-5940 escape hatch: proceed even though your CACHED context-pressure bucket reads critical. Pass true only when your OWN live context gauge contradicts it — the cached bucket is refreshed by a ~2-minute watchdog sweep, so it lags your per-turn reading and can read critical while you are fine. Not a way to skip a compaction you actually need.",
                      "type": "boolean"
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
                  "papercusp/resultFormats": [
                    "json"
                  ],
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
                "name": "plans:get",
                "description": "Fetch the full parsed structure of one plan by slug: frontmatter, ## Now (state + next), items with effectiveStatus, decisions. Resolves archived plans too. Judge callers also receive the exact latest activation-audit record and requirement mappings as `latestActivationAudit`. An exact slug can auto-resolve its owning harness within the caller's workspace ONLY from an unscoped (operator/superuser) session; a session already scoped to a concrete harness stays scoped to it and reports which harness actually owns the slug on a miss. Pass a concrete `harness` (for example, 'papercusp') to disambiguate, constrain, or escape the ambient scope. `harness: 'all'` is only valid in an unscoped (--all-workspaces) session.",
                "inputSchema": {
                  "type": "object",
                  "properties": {
                    "harness": {
                      "description": "Concrete in-scope harness slug (e.g. papercusp); harness-scoped sessions infer it. all requires unscoped --all-workspaces. Only UNSCOPED plans:get/plans:items auto-resolve an exact slug across harnesses; scoped misses identify the owning harness, which you must then pass explicitly.",
                      "type": "string",
                      "minLength": 1
                    },
                    "slug": {
                      "description": "Plan slug as returned by plans:list or plans:search. Plans are resolved from the PG-canonical store, not from a filename.",
                      "type": "string",
                      "minLength": 1
                    },
                    "slugs": {
                      "description": "Plan slugs to fetch in one call. Equivalent to calling this tool once per slug.",
                      "minItems": 1,
                      "maxItems": 100,
                      "type": "array",
                      "items": {
                        "$ref": "#/$defs/2"
                      }
                    },
                    "revision": {
                      "description": "Immutable revision sequence or content hash from plans:revisions. Requires one slug. Reads only that scoped snapshot, never falls back to current content, and omits live enrichments and the current CAS version. Heading, decision and item selectors still apply.",
                      "anyOf": [
                        {
                          "$ref": "#/$defs/4"
                        },
                        {
                          "type": "string",
                          "pattern": "^[a-f0-9]{64}$"
                        }
                      ]
                    },
                    "items": {
                      "description": "Select P-NNN item records. Counts cover the whole plan; itemSelection reports requested/matched/missing ids.",
                      "maxItems": 100,
                      "type": "array",
                      "items": {
                        "$ref": "#/$defs/2"
                      }
                    },
                    "itemIds": {
                      "description": "Compatibility alias for `items` (plans:items' spelling of the same selector); `items` wins when both are supplied.",
                      "maxItems": 100,
                      "type": "array",
                      "items": {
                        "$ref": "#/$defs/2"
                      }
                    },
                    "decisionId": {
                      "description": "Return one decision by id with its complete body from the plan named by slug (decision ids are plan-local, so slug or slugs is still required). This is a narrow selection/CAS read; decisionSelection reports the requested, matched, and missing ids.",
                      "type": "string",
                      "minLength": 1
                    },
                    "decisions": {
                      "description": "Return only these decision ids with complete bodies from the plans named by slug/slugs (decision ids are plan-local, so slug or slugs is still required). This is a narrow selection/CAS read; counts still describe the whole plan and decisionSelection reports requested/matched/missing ids.",
                      "maxItems": 100,
                      "type": "array",
                      "items": {
                        "$ref": "#/$defs/2"
                      }
                    },
                    "decisionIds": {
                      "description": "Compatibility alias for `decisions` (plural naming, matching `itemIds`); `decisions` wins when both are supplied.",
                      "maxItems": 100,
                      "type": "array",
                      "items": {
                        "$ref": "#/$defs/2"
                      }
                    },
                    "mode": {
                      "description": "Response depth: meta = frontmatter, Now, counts, section headings; sections (default) adds structured items/decisions, excerpting long decision bodies with explicit truncation flags; full adds markdown prose, item rawLine, and complete decision bodies. Use plans:export for exact raw bytes.",
                      "type": "string",
                      "enum": [
                        "meta",
                        "sections",
                        "full"
                      ]
                    },
                    "detail": {
                      "description": "Compatibility alias for `mode`: true or 'full' maps to mode:'full'; false or 'summary' maps to the default mode:'sections'. Explicit `mode` wins when both are supplied.",
                      "anyOf": [
                        {
                          "type": "boolean"
                        },
                        {
                          "type": "string",
                          "enum": [
                            "summary",
                            "full"
                          ]
                        }
                      ]
                    },
                    "heading": {
                      "description": "Return only the body of the section whose heading matches (case-insensitive), plus identity + the CAS baseline (contentHash/version) so you can edit what you just read — read one part of a long plan without pulling the whole body (like docs:get's heading-narrowing). Deliberately NOT the ## Now block, promotePolicy, or frontmatter.raw: EI-19478970139996135 measured those at 73% of a heading read, shipping the same prose three times over. `sectionIndex` comes back ONLY when the heading MISSES, which is when you need it to find the one you meant. Overrides mode.",
                      "type": "string"
                    },
                    "includeHistory": {
                      "description": "Include descendant work history on a full plan read (default true). Body-only UI readers may set false. An explicit History heading or priorAttemptRefs still retrieves the requested history.",
                      "type": "boolean"
                    },
                    "includeEnrichments": {
                      "description": "Live lifecycle/issue/feature/test/rubric/audit decorations (default true); false = fast body-first read.",
                      "type": "boolean"
                    },
                    "includeRaw": {
                      "description": "Also return the EXACT raw Markdown content stored for the plan as `raw` (full mode only). Off by default — the payload diet (P-008) drops `raw` because it duplicates `prose`+structured frontmatter, doubling agent tool-output. The plans admin UI sets this because it round-trips the whole content through plans:set-content (whose CAS hashes those exact bytes), and reconstructing raw from prose+frontmatter would not byte-match. Agents that just need the body should use `prose`; for a standalone dump use plans:export.",
                      "type": "boolean"
                    },
                    "include": {
                      "description": "Compatibility alias for `includeRaw`; `includeRaw` wins when both are supplied.",
                      "type": "boolean"
                    },
                    "priorAttemptRefs": {
                      "description": "Recover exact raw refs from this plan history; missing refs remain explicit.",
                      "maxItems": 20,
                      "type": "array",
                      "items": {
                        "$ref": "#/$defs/2"
                      }
                    },
                    "operationalBrief": {
                      "description": "Add `operationalBrief`: current phase, next executable item, blockers, authority, acceptance state and last verified evidence, projected from this same read. Fields not measured here are explicit `unknown` with a reason, never zero. Combine with shipReadiness:true for a measured ship verdict.",
                      "type": "boolean"
                    },
                    "shipReadiness": {
                      "description": "What blocks this plan's ship now, without the write: `shipReadiness` from the SAME evaluator plans:set-plan-status enforces (`satisfied`/`code` authoritative; the BAR snapshot's traces + `nextRepair` explain the rest). ⚠ ONE gate blocker at a time. ⚠ `satisfied:true` is not a clean pass until `skipped`, `forcedPast` and `unavailableReason` are read. Opt-in; not on heading/decisionId reads.",
                      "type": "boolean"
                    },
                    "current": {
                      "description": "shipReadiness proof: freshly measured evidence fingerprints, identical to plans:set-plan-status current. Missing comparisons remain unknown and cannot establish fulfillment.",
                      "maxItems": 2000,
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "planSlug": {
                            "$ref": "#/$defs/1"
                          },
                          "specId": {
                            "$ref": "#/$defs/1"
                          },
                          "specRevision": {
                            "$ref": "#/$defs/4"
                          },
                          "specFingerprint": {
                            "$ref": "#/$defs/3"
                          },
                          "evidenceKind": {
                            "type": "string",
                            "enum": [
                              "test",
                              "fixture",
                              "coverage-census",
                              "mutation",
                              "counterexample",
                              "check",
                              "manual",
                              "operational",
                              "independent-verification"
                            ]
                          },
                          "evidenceRef": {
                            "$ref": "#/$defs/1"
                          },
                          "sourceFingerprint": {
                            "$ref": "#/$defs/3"
                          },
                          "testFingerprint": {
                            "$ref": "#/$defs/0"
                          },
                          "fixtureFingerprint": {
                            "$ref": "#/$defs/0"
                          },
                          "rubricFingerprint": {
                            "$ref": "#/$defs/0"
                          },
                          "environmentFingerprint": {
                            "$ref": "#/$defs/0"
                          }
                        },
                        "required": [
                          "evidenceKind",
                          "evidenceRef",
                          "sourceFingerprint"
                        ],
                        "additionalProperties": false
                      }
                    },
                    "activationReadiness": {
                      "description": "Read-only activation preview: activationReadiness.consult gives plans:start's candidates, evidence, provenance and no-responder/degraded outcome, without opening a consult. Read before activation audit/start to shape clauses.",
                      "type": "boolean"
                    },
                    "efficiency": {
                      "description": "Add `efficiency`: the plan's agent MCP calls (goal_ref in its work items) by purpose, failed calls by class, calls on dropped items, holder changes, and holders' active/idle wall-clock. Counts are floors (native tools write no row).",
                      "type": "boolean"
                    }
                  },
                  "additionalProperties": false,
                  "$defs": {
                    "0": {
                      "anyOf": [
                        {
                          "$ref": "#/$defs/3"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "1": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 2000
                    },
                    "2": {
                      "type": "string",
                      "minLength": 1
                    },
                    "3": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 256
                    },
                    "4": {
                      "type": "integer",
                      "exclusiveMinimum": 0,
                      "maximum": 9007199254740991
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
              },
              {
                "name": "events:await",
                "description": "Register a one-shot WAKE on an event key/pattern; when it fires you are re-invoked, so end your turn instead of polling. Patterns wake on their first match; `spec` threshold trees wake when satisfied.",
                "inputSchema": {
                  "type": "object",
                  "properties": {
                    "event": {
                      "description": "Event key to wait on (mutually exclusive with `spec`). An EXACT key (`lock:grant:t1`) matches that one key. A PATTERN — a glob with `*` (`work-item:done:*`), or a macro `@plan:<slug>` (→ any plan item done) / `@fleet:<slug>` (→ any fleet event) — wakes on the FIRST key that matches. `*` matches any run of characters.",
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 200
                    },
                    "after_generation": {
                      "description": "Pin this await to the exact announced declaration generation returned by events:status; stale pins return a structured resync response.",
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    },
                    "spec": {
                      "description": "Composed THRESHOLD TREE (mutually exclusive with `event`): wake ONCE when a combination of event occurrences is satisfied. A leaf is { event, when? } (`when` = a payload_filter DataCondition on that event). Combinators: { all: [...] } = every child; { any: [...] } = ≥1 child; { some: { require: k, of: [...] } } = k-of-n. Nest ≤3 deep, ≤20 leaves total; event-level negation is not supported (absence is observed by the deadline). e.g. { any: [ { event: \"deploy:done\" }, { all: [ { event: \"ci:green\" }, { event: \"review:approved\" } ] } ] }. IMPORTANT: the root is whole-tree one-shot; an `any` match consumes and voids every sibling. Do not mix frequent/non-terminal events with rare/terminal events unless the first match is intentionally terminal; split those waits or use an explicit threshold that matches the lifecycle. Deadline via timeout_sec/on_timeout as usual; a tree already satisfied at registration returns already_satisfied WITHOUT registering.",
                      "type": "object",
                      "propertyNames": {
                        "type": "string"
                      },
                      "additionalProperties": {}
                    },
                    "note": {
                      "description": "Why you are waiting — echoed into the wake turn so resumed-you has the thread. Auto-truncated to 2000 chars if longer.",
                      "type": "string"
                    },
                    "timeout_sec": {
                      "description": "Deadline in seconds (default 1800). See on_timeout.",
                      "type": "integer",
                      "exclusiveMinimum": 0,
                      "maximum": 604800
                    },
                    "on_timeout": {
                      "description": "What happens at the deadline without the event: 'wake' (default) = you are woken with a TIMEOUT marker (the non-event is as actionable as the event); 'expire' = the await lapses silently (visible in events:status).",
                      "type": "string",
                      "enum": [
                        "wake",
                        "expire"
                      ]
                    },
                    "plan_run_id": {
                      "description": "When awaiting FROM a plan run, pass its runId — the wake re-invokes the run via the plans:resume path instead of a session resume.",
                      "type": "integer",
                      "exclusiveMinimum": 0,
                      "maximum": 9007199254740991
                    },
                    "payload_filter": {
                      "description": "EI-8998: also require the emitted PAYLOAD to satisfy this predicate before firing, e.g. { queue_depth: { lt: 5 } } — same vocabulary as an ECA rule's `when`. Only takes effect combined with an `event` key/pattern the emitter actually fires. Omitted on event:'work-item:claimable'? EI-13846: it is auto-narrowed to YOUR OWN claim spec when one exists (see auto_scoped_payload_filter in the response) — pass this explicitly to override.",
                      "$ref": "#/$defs/__schema0"
                    },
                    "producer_health": {
                      "description": "Verified producer health for a single event/fromMsg wait; requires `event` or `fromMsg` and is rejected with a composed `spec`.",
                      "type": "object",
                      "properties": {
                        "kind": {
                          "type": "string",
                          "const": "green-checkpoint"
                        },
                        "pipeline": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 64,
                          "description": "Sanitized basename of the integration root that emits the event (for example \"papercusp\" in release:green:papercusp), not the routine name \"green-checkpoint\"."
                        },
                        "candidate_sha": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 128
                        },
                        "run_id": {
                          "$ref": "#/$defs/0"
                        },
                        "expected_cadence_sec": {
                          "$ref": "#/$defs/3"
                        },
                        "owner_id": {
                          "$ref": "#/$defs/0"
                        },
                        "work_item_id": {
                          "$ref": "#/$defs/0"
                        }
                      },
                      "required": [
                        "kind",
                        "pipeline",
                        "expected_cadence_sec"
                      ],
                      "additionalProperties": false
                    },
                    "progress_lease": {
                      "description": "Evidence-backed liveness lease for a delegated upstream owner. Uses an authoritative read-only tool/path and automatically wakes owner_id on the first cadence miss. After repeated misses, remedy must use one of spec-widen, outside-lane-placement, leader-claim, or create-unblock-item; wake-owner is not a valid remedy kind.",
                      "type": "object",
                      "properties": {
                        "source_kind": {
                          "type": "string",
                          "enum": [
                            "state-cell",
                            "tool-call-delta",
                            "checkpoint-revision",
                            "managed-task-advance",
                            "claim-transition"
                          ]
                        },
                        "tool": {
                          "$ref": "#/$defs/0"
                        },
                        "args": {
                          "type": "object",
                          "propertyNames": {
                            "type": "string"
                          },
                          "additionalProperties": {}
                        },
                        "path": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 300
                        },
                        "op": {
                          "type": "string",
                          "enum": [
                            "changed",
                            "increased"
                          ]
                        },
                        "units": {
                          "$ref": "#/$defs/2"
                        },
                        "writer": {
                          "$ref": "#/$defs/0"
                        },
                        "expected_cadence_sec": {
                          "$ref": "#/$defs/3"
                        },
                        "owner_id": {
                          "$ref": "#/$defs/0"
                        },
                        "work_item_id": {
                          "$ref": "#/$defs/0"
                        },
                        "remedy_after_misses": {
                          "type": "integer",
                          "minimum": 2,
                          "maximum": 10
                        },
                        "remedy": {
                          "oneOf": [
                            {
                              "type": "object",
                              "properties": {
                                "kind": {
                                  "type": "string",
                                  "const": "spec-widen"
                                },
                                "instructions": {
                                  "$ref": "#/$defs/4"
                                }
                              },
                              "required": [
                                "kind",
                                "instructions"
                              ],
                              "additionalProperties": false
                            },
                            {
                              "type": "object",
                              "properties": {
                                "kind": {
                                  "type": "string",
                                  "const": "outside-lane-placement"
                                },
                                "instructions": {
                                  "$ref": "#/$defs/4"
                                }
                              },
                              "required": [
                                "kind",
                                "instructions"
                              ],
                              "additionalProperties": false
                            },
                            {
                              "type": "object",
                              "properties": {
                                "kind": {
                                  "type": "string",
                                  "const": "leader-claim"
                                },
                                "workItemId": {
                                  "anyOf": [
                                    {
                                      "$ref": "#/$defs/0"
                                    },
                                    {
                                      "type": "null"
                                    }
                                  ]
                                },
                                "harness": {
                                  "anyOf": [
                                    {
                                      "$ref": "#/$defs/2"
                                    },
                                    {
                                      "type": "null"
                                    }
                                  ]
                                }
                              },
                              "required": [
                                "kind"
                              ],
                              "additionalProperties": false
                            },
                            {
                              "type": "object",
                              "properties": {
                                "kind": {
                                  "type": "string",
                                  "const": "create-unblock-item"
                                },
                                "title": {
                                  "type": "string",
                                  "minLength": 1,
                                  "maxLength": 1000
                                },
                                "summary": {
                                  "anyOf": [
                                    {
                                      "type": "string",
                                      "minLength": 1,
                                      "maxLength": 8000
                                    },
                                    {
                                      "type": "null"
                                    }
                                  ]
                                },
                                "harness": {
                                  "$ref": "#/$defs/2"
                                }
                              },
                              "required": [
                                "kind",
                                "title",
                                "harness"
                              ],
                              "additionalProperties": false
                            }
                          ],
                          "description": "Applied after repeated cadence misses. The first cadence miss automatically wakes owner_id; accepted kinds are spec-widen, outside-lane-placement, leader-claim, and create-unblock-item. wake-owner is not a remedy kind."
                        }
                      },
                      "required": [
                        "source_kind",
                        "tool",
                        "path",
                        "units",
                        "expected_cadence_sec",
                        "owner_id",
                        "remedy"
                      ],
                      "additionalProperties": false
                    },
                    "fromMsg": {
                      "description": "coord-authority-hardening P-006: a coord msg_id — await the gate THAT message declared (its `gateRefs` stamps, read server-side). `fromMsg` resolves gateRefs only; it does not consume a coord:send `expectEffect` directive. ExpectEffect compliance is reported on fleet:leader-brief → members[].directiveActuation. Kills hand-typed key drift: you never re-type the key, the platform resolves it off the message. Exactly one gate on the message is required — none/many is a loud error naming what it found. Mutually exclusive with `event`/`spec`.",
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 200
                    }
                  },
                  "additionalProperties": false,
                  "$defs": {
                    "0": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 200
                    },
                    "1": {
                      "type": "array",
                      "items": {
                        "$ref": "#/$defs/__schema0"
                      }
                    },
                    "2": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 120
                    },
                    "3": {
                      "type": "integer",
                      "exclusiveMinimum": 0,
                      "maximum": 604800
                    },
                    "4": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 2000
                    },
                    "__schema0": {
                      "anyOf": [
                        {
                          "type": "object",
                          "properties": {
                            "all": {
                              "$ref": "#/$defs/1"
                            }
                          },
                          "required": [
                            "all"
                          ],
                          "additionalProperties": false
                        },
                        {
                          "type": "object",
                          "properties": {
                            "any": {
                              "$ref": "#/$defs/1"
                            }
                          },
                          "required": [
                            "any"
                          ],
                          "additionalProperties": false
                        },
                        {
                          "type": "object",
                          "properties": {
                            "some": {
                              "type": "object",
                              "properties": {
                                "require": {
                                  "type": "integer",
                                  "minimum": 1,
                                  "maximum": 9007199254740991
                                },
                                "of": {
                                  "$ref": "#/$defs/1"
                                }
                              },
                              "required": [
                                "require",
                                "of"
                              ],
                              "additionalProperties": false
                            }
                          },
                          "required": [
                            "some"
                          ],
                          "additionalProperties": false
                        },
                        {
                          "type": "object",
                          "properties": {
                            "not": {
                              "type": "object",
                              "additionalProperties": true,
                              "description": "recursive object validated by the tool"
                            }
                          },
                          "required": [
                            "not"
                          ],
                          "additionalProperties": false
                        },
                        {
                          "type": "object",
                          "propertyNames": {
                            "type": "string"
                          },
                          "additionalProperties": {},
                          "not": {
                            "maxProperties": 1,
                            "anyOf": [
                              {
                                "required": [
                                  "all"
                                ]
                              },
                              {
                                "required": [
                                  "any"
                                ]
                              },
                              {
                                "required": [
                                  "some"
                                ]
                              },
                              {
                                "required": [
                                  "not"
                                ]
                              }
                            ]
                          }
                        }
                      ]
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
                "name": "events:cancel",
                "description": "Cancel one of your active events:await registrations (await_id — you will not be woken), retire one of your unfired announced gate declarations (announcement_id, optionally guarded by expected_generation), cancel a whole composed await TREE by its root_id, or ACK a pending/parked wake delivery (delivery_id). Evidence-only judges may only ACK their own wake deliveries. Standing once:false watches require confirm_standing:true after checking events:status because queued deliveries are dropped with the watch. An active loop owner cannot cancel their coord:inbox-wake; call loop:end first. Loopless owners may still opt out. Pass at least one.",
                "inputSchema": {
                  "type": "object",
                  "properties": {
                    "await_id": {
                      "description": "The id events:await returned — retract the subscription.",
                      "type": "integer",
                      "exclusiveMinimum": 0,
                      "maximum": 9007199254740991
                    },
                    "confirm_standing": {
                      "description": "Required when canceling a standing once:false watch; inspect events:status first because queued deliveries are also dropped.",
                      "type": "boolean"
                    },
                    "await_ids": {
                      "description": "await registrations to cancel",
                      "minItems": 1,
                      "maxItems": 200,
                      "type": "array",
                      "items": {
                        "type": "integer",
                        "exclusiveMinimum": 0,
                        "maximum": 9007199254740991
                      }
                    },
                    "delivery_id": {
                      "description": "A pending/parked wake delivery id (from events:status or the inbox nudge) — acknowledge it as received.",
                      "type": "integer",
                      "exclusiveMinimum": 0,
                      "maximum": 9007199254740991
                    },
                    "delivery_ids": {
                      "description": "parked wake deliveries to acknowledge",
                      "minItems": 1,
                      "maxItems": 200,
                      "type": "array",
                      "items": {
                        "type": "integer",
                        "exclusiveMinimum": 0,
                        "maximum": 9007199254740991
                      }
                    },
                    "root_id": {
                      "description": "A composed await TREE root id (from events:status) — cancel the whole tree (cascades to every leaf + node).",
                      "type": "integer",
                      "exclusiveMinimum": 0,
                      "maximum": 9007199254740991
                    },
                    "root_ids": {
                      "description": "composed await trees to cancel",
                      "minItems": 1,
                      "maxItems": 200,
                      "type": "array",
                      "items": {
                        "type": "integer",
                        "exclusiveMinimum": 0,
                        "maximum": 9007199254740991
                      }
                    },
                    "announcement_id": {
                      "$ref": "#/$defs/0"
                    },
                    "announcement_ids": {
                      "description": "announced gate declaration ids to retire",
                      "minItems": 1,
                      "maxItems": 200,
                      "type": "array",
                      "items": {
                        "type": "integer",
                        "exclusiveMinimum": 0,
                        "maximum": 9007199254740991
                      }
                    },
                    "expected_generation": {
                      "description": "The declaration generation last observed; only applies to announcement_id.",
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    },
                    "items": {
                      "description": "mixed await/delivery/tree cancel or ack operations",
                      "minItems": 1,
                      "maxItems": 200,
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "await_id": {
                            "description": "The id events:await returned — retract the subscription.",
                            "type": "integer",
                            "exclusiveMinimum": 0,
                            "maximum": 9007199254740991
                          },
                          "confirm_standing": {
                            "description": "Required when canceling a standing once:false watch; inspect events:status first because queued deliveries are also dropped.",
                            "type": "boolean"
                          },
                          "delivery_id": {
                            "description": "A pending/parked wake delivery id — acknowledge it as received.",
                            "type": "integer",
                            "exclusiveMinimum": 0,
                            "maximum": 9007199254740991
                          },
                          "root_id": {
                            "description": "A composed await TREE root id (from events:status) — cancel the whole tree.",
                            "type": "integer",
                            "exclusiveMinimum": 0,
                            "maximum": 9007199254740991
                          },
                          "announcement_id": {
                            "$ref": "#/$defs/0"
                          },
                          "expected_generation": {
                            "description": "The declaration generation last observed; prevents retiring a newer replacement.",
                            "type": "integer",
                            "minimum": 0,
                            "maximum": 9007199254740991
                          }
                        },
                        "additionalProperties": false
                      }
                    }
                  },
                  "additionalProperties": false,
                  "$defs": {
                    "0": {
                      "description": "An announced gate declaration id from events:status — retire the unfired declaration.",
                      "type": "integer",
                      "exclusiveMinimum": 0,
                      "maximum": 9007199254740991
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
              },
              {
                "name": "events:catalog",
                "description": "List the awaitable event-key families — the answer to \"what can I wait on instead of polling?\". Each row: the key template (+ a ready events:await example), what it means, who emits it, whether it fires TODAY, the poll it replaces, its sugar verb (e.g. deploy:await), and `live_awaiters` — how many agents are registered on that key RIGHT NOW (EI-9000). Supports case-insensitive free-text `q` (compatibility aliases `pattern`/`query`) over family/key/description/emitter and a bounded `limit` for family rows. Check here before you poll dev:pipeline_position / dev:build_status / a peer's status. Scope comes from request context; installed families use the call's harness, and announced gates use the reader's fleet/plan/harness visibility. Do not pass `scope`, `pot`, or `harness` as JSON filters; narrow with `q`/`pattern`/`query`/`family`.",
                "inputSchema": {
                  "type": "object",
                  "properties": {
                    "q": {
                      "description": "Case-insensitive substring over family, key, await example, description, emitter, provenance, and sugar. Also accepted, folded into q before parse (q wins): pattern, query.",
                      "type": "string",
                      "maxLength": 200
                    },
                    "limit": {
                      "description": "Max family rows returned (default all; maximum 200).",
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 200
                    },
                    "family": {
                      "description": "Filter to one family id (e.g. \"deploy\", \"work-item\"). Omit for the whole catalog.",
                      "type": "string",
                      "maxLength": 64
                    },
                    "awaitable_now": {
                      "description": "true = only families whose emitter fires TODAY (hide not-yet-wired Phase-2 keys).",
                      "type": "boolean"
                    },
                    "subjectScope": {
                      "description": "Filter by whether you can park on the key WITHOUT already knowing the subject (EI-19299170840541307). `id` = usable only if you already hold the specific id; `scope` = usable if you know a durable scope you own (fleet/plan/workspace/account/owner); `global` = usable by anyone, narrow with payload_filter; `unknown` = not classifiable from the template (installed packs only). A fleet leader asking \"what can I actually wait on?\" wants [\"global\",\"scope\"] — the id-scoped families are unusable to anyone who does not already know which subject will move next. Accepts one value or an array.",
                      "anyOf": [
                        {
                          "$ref": "#/$defs/0"
                        },
                        {
                          "minItems": 1,
                          "maxItems": 4,
                          "type": "array",
                          "items": {
                            "$ref": "#/$defs/0"
                          }
                        }
                      ]
                    },
                    "liveAwaiters": {
                      "description": "default true — attach `live_awaiters` (current registered-await count) per family. Pass false to skip the extra DB read on a hot path that only needs the static catalog.",
                      "type": "boolean"
                    },
                    "announced": {
                      "description": "default true — also list ANNOUNCED gate events (EI-9270: dynamic, leader-declared keys — events:emit { announce:true }) visible to your fleet/plan/harness (+ global), each with fired/latched state and live_awaiters. Pass false to skip.",
                      "type": "boolean"
                    },
                    "installed": {
                      "description": "default true — also fold in event families declared by INSTALLED packs/plugins (`provides.events`), each tagged `provenance: \"installed:<unit>\"`. Pass false for the builtin registry only.",
                      "type": "boolean"
                    }
                  },
                  "additionalProperties": false,
                  "$defs": {
                    "0": {
                      "type": "string",
                      "enum": [
                        "id",
                        "global",
                        "scope",
                        "unknown"
                      ]
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
                "name": "checkpoint:await",
                "description": "Sleep until the pipeline green-checkpoint resolves — arms awaits on release:green:<pipeline> (passed), green-checkpoint:red:<pipeline> (held), and green-checkpoint:inconclusive:<pipeline> (no verdict — a wedge; payload.reason names why). candidateSha (EI-12457) binds to your exact candidate; omit it to wake on any candidate and lineage-check payload.sha via release:trace — see the candidateSha arg for the WI-5685 race caveat (a later candidate containing your commit will NOT wake a sha-bound await). An already-judged candidateSha returns already_judged, not a dead wait. runId binds to the exact judging run (without pipeline: global keys filtered by runId). pipeline overrides; global:true = every co-hosted pipeline. Re-arming retires your prior pending wait. Then END YOUR TURN.",
                "inputSchema": {
                  "type": "object",
                  "properties": {
                    "pipeline": {
                      "description": "Scope to ONE pipeline's gate — the repo basename of its integration root (e.g. 'papercusp'). Omit to default to the current dev pipeline, unless runId is supplied (then global keys are filtered to that exact run). Use global:true for the global keys, which wake on EVERY co-hosted pipeline's verdict (EI-7646: you then must lineage-check payload.sha/payload.pipeline yourself).",
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 64
                    },
                    "candidateSha": {
                      "description": "EI-12457: bind the wait to this exact candidate (full sha or a prefix) via a payload predicate on the emitted payload.sha — a verdict for any OTHER candidate (a stale/superseded run) will NOT wake you; you keep sleeping until the correct candidate resolves or the deadline. Strongly recommended whenever you know which commit you are judging (e.g. right after a git-sync:await/deploy). WI-5685: this is an EXACT match, not an ancestry check — a LATER candidate that still contains your commit (e.g. the hourly cron races ahead and judges a newer tip) will NOT wake you even though its green verdict already covers you. If a cron tick could plausibly land before your exact candidate does, omit candidateSha (wake on ANY verdict for this pipeline) and confirm inclusion afterwards with release:trace instead of binding here. EI-18676650746298156: if this EXACT candidate was already judged before you armed (recorded in harness_shared.pipeline_events), you get already_judged:true immediately instead of sleeping to the timeout — this is the same EXACT-match rule as above, so it can never be fooled by a later candidate that merely contains your commit.",
                      "type": "string",
                      "minLength": 4,
                      "maxLength": 64
                    },
                    "runId": {
                      "description": "WI-4957: bind further to the EXACT run (payload.runId, an exact match) that judged your candidate — only needed when two runs might judge the SAME candidate sha (a re-fire, or a routine/manual race) and you must not accept the other one's verdict. With no explicit pipeline, runId uses the global event keys so the exact run can be awaited across co-hosted installs. Combines with candidateSha (both must match); rarely needed on its own.",
                      "type": "string",
                      "minLength": 4,
                      "maxLength": 64
                    },
                    "global": {
                      "description": "Use the global release:green / green-checkpoint:red keys instead of the current pipeline's keys. Only for cross-pipeline monitors.",
                      "type": "boolean"
                    },
                    "note": {
                      "description": "Why you are waiting — echoed into the wake turn.",
                      "type": "string",
                      "maxLength": 2000
                    },
                    "timeout_sec": {
                      "description": "Deadline in seconds (0 = bounded immediate probe; default 11400 ≈ 190min — WI-5685: sized to the suite's real worst-case ceiling, the 180min systemd backstop + slack, NOT the generic events:await default (1800s) which used to strand a default-timeout caller mid-suite); on the deadline you are woken with a TIMEOUT marker.",
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 604800
                    },
                    "on_timeout": {
                      "description": "What happens at the deadline without the event: 'wake' (default) = re-invoke with a TIMEOUT marker; 'expire' = lapse silently (visible in events:status).",
                      "type": "string",
                      "enum": [
                        "wake",
                        "expire"
                      ]
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
              }
            ]
          }
        }
      ],
      "toolCount": 50,
      "limits": [
        "SDK-decoded tools/list pages, not raw HTTP wire bytes or a native model tool-list frame.",
        "Caller configuration and launch attribution require independent native/launch receipt verification.",
        "Input schemas do not prove effective argument authorization; full P-001 and historical acceptance remain open."
      ],
      "configPath": "/home/marsh-office/.papercusp/su-codex-homes/session-53877/config.toml"
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
          "ownerId": "su-f767a5c2-69cd-4c73-8e9e-6387e8e826c2",
          "receiptId": "RG-fab7432a-3fb2-4070-a709-809012ea084c",
          "admission": null,
          "outcome": "opened"
        }
      ],
      "opened": 1,
      "failed": 0,
      "failures": [],
      "partial": false,
      "command": "psu --launched-by=su-4a84c93a-e530-450c-b01e-8beb7bdc670f --no-picker --account=auto --agent=codex --owner-id=su-f767a5c2-69cd-4c73-8e9e-6387e8e826c2 --harness=papercusp --plan=identity-definitions-own-policy-2026-10-17 --headless --carry=warm --model=gpt-6.1-sol:xhigh --model-source=configured-default --role=architect --feature=WI-6554700010017386",
      "fleet": null,
      "independent": false,
      "goalVerifier": null,
      "verifierCoupling": null,
      "headcountProfile": null,
      "mode": "fresh",
      "resumedOwnerId": null,
      "ownerIds": [
        "su-f767a5c2-69cd-4c73-8e9e-6387e8e826c2"
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
          "taskId": "0mvt0hhiqjvwqo61w5f",
          "logPath": "/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/fleet-logs/P001-architect-current-build-catalog-2759672-1793246197480.log",
          "normalizedLogPath": "/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/fleet-logs/P001-architect-current-build-catalog-2759672-1793246197480.normalized.log",
          "pid": 1271539,
          "terminalPid": null,
          "label": "P001 architect current build catalog",
          "ownerId": "su-f767a5c2-69cd-4c73-8e9e-6387e8e826c2",
          "headless": true,
          "kickoffProof": {
            "persisted": true,
            "nativeRef": "/home/marsh-office/.papercusp/su-codex-homes/session-53877/sessions/2026/10/28/rollout-2026-10-28T23-56-49-01a185cd-a670-7a90-89a2-31afe44c2fd3.jsonl",
            "reason": null
          },
          "nativeSession": {
            "backend": "codex",
            "source": "adv_sessions",
            "ownerId": "su-f767a5c2-69cd-4c73-8e9e-6387e8e826c2",
            "codexHome": "/home/marsh-office/.papercusp/su-codex-homes/session-53877",
            "rolloutId": "01a185cd-a670-7a90-89a2-31afe44c2fd3",
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
            "ownerId": "su-f767a5c2-69cd-4c73-8e9e-6387e8e826c2",
            "sessionId": "01a185cd-a670-7a90-89a2-31afe44c2fd3",
            "advSessionId": 53877
          }
        ]
      }
    },
    "completionReceipt": {
      "status": "recorded",
      "effectRef": "agent-launch:idop-p001-architect-actual-catalog-fire47-staging"
    }
  },
  "native": {
    "path": "/home/marsh-office/.papercusp/su-codex-homes/session-53877/sessions/2026/10/28/rollout-2026-10-28T23-56-49-01a185cd-a670-7a90-89a2-31afe44c2fd3.jsonl",
    "nativeSessionId": "01a185cd-a670-7a90-89a2-31afe44c2fd3",
    "ownerId": "su-f767a5c2-69cd-4c73-8e9e-6387e8e826c2",
    "selectedRecords": [
      {
        "line": 2,
        "bytes": 496,
        "sha256": "a692f5126afaf7bfb533d5ac31ac2375afe019371caea3f57b8276d15723751b",
        "gzipBase64": "H4sIAAAAAAAC/51QzW6DMAy+7zF8hikESIHn6GmXyCWBRQ0JCmZdVfHuM9OYdtx2sCz5+7O+B5Cb7EI4zdCBFFLlhchlexZlV6uuFs9KlS+QQUzGBfTQFRnQfbbMtm82kJ6WkeEZ7z6ige5xoITLVbNxImuYQGsKGomSu6zkYvhk7jfHIhAFFk3dmxybdshPZSNzRFR5PRQlj6lsqw4TthhHm1i1Lrz27LQ/8u0WVu8zcMGRQ3Jh1Dju+Iz0eoApxh+C38Vv2d8f/k9OBl+tcV1c96ktZaVkITKYorFe9zGQfSd9c8HEG3SNbCrBaB+9x0tMuNerd66+MoVjjR1w9QTb9vQBI6BdCPABAAA="
      },
      {
        "line": 14,
        "bytes": 675,
        "sha256": "cadf29c3dae62de4d2d1250871b1e2f6217514520ea14c0f743e2b882007ffd7",
        "gzipBase64": "H4sIAAAAAAAC/0WS3W7jIBCF7/cpLF+1UogB/7vat9irVSRrAuOY1hgE422iKO++OFXVCwQavpk5cOaek7EYCazPh1xy2TDBmez/8HKo24GXRy7Lv/khd0GbFZZ8EOUhp5vHhAeM3q0RR0NoE+PhtjjQ+XD/JtQWydmRnFtGBcuSIKP3OKmRt0oB8LrlounOdZU2QKkqjmJqeCd6fp503/SiBiV1KwRP2UkpbXGv4KxfkFCn4F55/Kq7n86VLqXkTV81bdUq3p8rbLqu0lh3Zav7lLGC3eXhFdUuafUbPWuukbKQ/c7gEwxlu+x43KExtbOw6pe7sno45avTmDFmrHchcfGaRRWMp1go8LQFZEY7zzzngi3mHzIFBIu7HClmBVlf/FxDUHP6P0UMFG2wfKNsMgGr9vge3XrKD58ufGgTUu9idhYLCyHOzE2TUVh48BjU5sGwnYsefoLRp2wL19FtlJ6ZvPjANQ6Sc364GVz0uE/AaOMgUujx+pYRXuklvL6d1uffEIZk/KhmoDGNSoRLopFAJ52jhxhpDm67zE/bt7B+OcEFiK5WmkHXT6wtO8kAoGH1JMq0dIV9s1sXEAifEtJotX0pq0ZKeUxQcrx9PB6//gNr3BNeowIAAA=="
      },
      {
        "line": 16,
        "bytes": 673,
        "sha256": "13612c9815fdd0b2c1b17774afbaff817ef142369b7bec242bcc3b1864085867",
        "gzipBase64": "H4sIAAAAAAAC/31Swa7bIBC89ysiznaEMcbGP9FDK1VqXaENbBIUGyzAbZ8i/3vB6XvHHtCi3dnZYZYnSXbBmGBZyUgYZaJuaM3kV9qOXT9SfhY9/04q4oOxDmYyNl1F0tuKGR4wrt5FVDbhkjErvM0eDBmf7wi9xeQXlbyflYZ5Vn5L65Yy1ppSTtor2kAzdNrU2DBW9wKbGi7Y1bwFPmhOB0CWG472V1e5XbhpGaNC8iyw11ReOIph4Aa7oe2NLJJfs8YfH3KsywmV8E9RcISRfNHBrumk/bLOmNBM7lvmPxVbTs1ZnCJq70yc3OeDbpwc2av/Mj4nou+be2S1ExknIjljjZhINZHfRXqhVu+02dAzpVSyQXZdRkSM0Xr36m0EpyXpg70V97ORD3RK+82lXKaldKg65kxkJ/vPbK1LGApa3yGpvN0IN8wxgYEEaoUY0z347XY/NrUF9/L1YxEwyGvdtwOrAUDU3bVp8zEcpSiLCAgJj1dkhb1sGReMHR+lk5Lve0XeZxV+PVt0ScGW7j5gnnOFOWJFcpgvoB//3jTbxSblf2EI1hRill3Z909/AeaQDiOhAgAA"
      },
      {
        "line": 19,
        "bytes": 507,
        "sha256": "0f5d0376d5db0953e158cfd0f09712554d742b6953bf6241b3da0a2a9857ad4e",
        "gzipBase64": "H4sIAAAAAAAC/zVRy4rcMBC85yuCTrtgD3pasvMbOYUB0ZbkHRPbMlabnWGYf09rlxyEpKa6uqr6yXBeU0FYdzYwyWXXCt7K/jdXg7GDUBcnzB/WsHzEeYOFDcI1DB97IviRyp63kvyMaSXMDo8lQ2TD8z8inAXz6jHnxQdYFgLNsdYxeG5DAODGctG50Wi6IMmgRW+t0k703E2gXB9Gq0eY9DRSNynFs1SGvO5LwhSpWJn9N299RTU6KftpClpqgNTbaIwQUXZCdB0X1LHBWuWlewpV0rafSF9Md3yDT5jxZ1VcLp8HOfMFyfrbs6RS5rzRoEF0mpsm3OAow5VdWbPC3ecTiYa8/k1bGSTnvHnMaYm+JuzXMggqvd7ff123r5mYDgrUEwt6WkGBD0IlhAgIfodS8Hbk8+P2Fed5bN8OuQDhTIgtuH5qrXKyBYCuNZNQdKJOfVcjORKQ9DqaVmZ7JXUnlbpoa3quzev1+vEPkddCYvsBAAA="
      },
      {
        "line": 22,
        "bytes": 827,
        "sha256": "21044bdbecb7abb7e66cb3ceed034043c0e82b21faa33c394bdb8ab2971b5bdc",
        "gzipBase64": "H4sIAAAAAAAC/31Sy67bIBDd9ysi1ibX4Le3/YAuWqlSS2VNYJzQELAwbu9V5H8vkJu7rCXzmMeZw5m5k6BvuAa4LWQkvOQtZSXlw7eyGptu5NWx5uwHKYjzSlswZOSsIOFtwRjucV2cXXHSAW8xZoE340CR8f6MkNsa3G0KzplJgjGT28KyhRirVXIH6aaSAesbiZRDo2jXYkWHU93TUs5qKLuT7GqMCTn9kZVOqjr1nA/zLGteA+DQqaZhTPGWsbYtWaL8qDX+/KCjbTRMAV8Tg7yN5Kv0egkH6W6LwYBK2O8R/5BkOQzH5rCidFatwn7JcKOwZC/+i3gXRF42e41sBRkFUW2tsBKkEORvop6gpycsGctjGb+qKbs+RuCrDpN0CpMn3p3X5yR81PCKNno2G6KrYsmXGeUadyE+7iJZ4vISbsuLVm6hS1kyCl5eYqNkoCDDBoZKCGDcmc7aY90df6/OprQiLU85MljwG2brAmdcs4nle+rr58wo2ZoyG2fQZvOPTLsZswthBdnJ/it23Qb06TXyAmGKg7dGxLgHUJHMtMC6hot32/mSh2jz9tHy9xlRFPphpl3VcwoALW1mVsVf1Ti0aUY8QsAscKTYDRWvW17nGa77bt8L8iyV4KXRaMMEW7g4j7HMDGbFIj7AmBPI67vkRt9iS9wf9F6rhMtju/b90z/owiMoOwMAAA=="
      },
      {
        "line": 24,
        "bytes": 973,
        "sha256": "7076ebf5bd28a86e5ecd1bba92e6ed93cceca1d37f28844ad4bfc1fcf5bc377c",
        "gzipBase64": "H4sIAAAAAAAC/11TTW/bMAy971cYvjTFbEf+ih0XOw0YsB02YN1pCGCwEp1otSVNkpcGWf77KKftsB0EUU+PjxRFnmMvJ3QeJhN3ccGKTZqztNh+Y2VXN13JsoZV3+Mk1lZIBWPcFWUS+5NBolt0RiuHvfQ4EcfAadQg4u78wuCz83rqvdZjz2EciSRFwD3vWcM5AKsblm/ah7qiDbDgVdGU+VC1+ZZBuanrbdvyqioYbzl5U6Z+dkFBT2ZEj4LAoNxfdYNVPNRbAaTD24eKYbPdlAxL3qJg+cAFIw8FU0gPnzCISmVmT0ePT34FR5A+Chm7LNz3FGkCJVZnPoluFystMEoxuuH0dB8NLnoXWfw5S4ur3e563w0umLd30ZVkiBOAtZ/MWgptUsNYnoLlByod9ylwP8OYcvAw6n06kFjVZD+cVsHtRUaQzKf7L58zA9bhanCZRRAf5Ij3J8VXJlmCzH5ol+iv4Tn5iSzUBm30+3d0vtxFxmqOzmXOCz377GgpkdUi7ryVai+H0+qsjwrtR9Hx7NlKFHj5C+/JU2q13PyHJBRykPvZoviqRyTCv0Dy8nEdZfRsJgb26AhY9iTU/r2elSfk1U4GkCOJEPZskZc/dOZyG71d3k1rp65lv4l2cXLU9lFIS1+2PugJ1xMV7ZDqYZAc1wYMWj4bkGngOQN/QWfIe4KnngpDjUHd+4jKdTljLDlJHEUfZqafrtCF6rxTSxd5tDQiPT+A72moHL2Gdg+CvrU34Jw/WD3vD8uAzFZde5blkLc1Fym02yFtyrZIAWCT1kNe0hIVbjehyemvPS6h4y5vtmVRbQpqkoKVjNblcnnzB2JsPDDNAwAA"
      },
      {
        "line": 27,
        "bytes": 5435,
        "sha256": "9c5fab180e29b05e0839c2ecf09674935ba320264dff0526f1ea51b196301b6d",
        "gzipBase64": "H4sIAAAAAAAC/51Y3W7byBW+71MMdBMbFSVKlCiJRoEu0kWbRbNZxN6m2FUhjziH0qzJGZZD2lENA3tVtLdFn6EPlifpd4bUj9eJkzZwZGt+zpyf73znzNz3al2Qq2VR9pLeOBzHwSgMxourMEqmsyRaDCaj8Q+9fs9WShuZ95Jx3O/Vu5KwvCJXWuNopWsqsKaUu9xK1Uvu9yvSxtW2WNXW5qtU5vnKNnXZ1FirFU/XqV2FIzmaT1MK4rmaBLP5Yhysx3EWrBVFFM6iKB4tsMFvb3fxX+P1dKHkZDxL5+tJSLNFHIUUpXNS4ShLVcgqt2clPx7U0QYDq5reswb+V9K7TCtd1iK1RZlTTWpp3kG+YLeI2WAqHKXWKLc0b7y4ZGl6D/1nJd4ve+m2MTfQdtlLlj1SSsbhstdf9u5YdRa92ovtJeEgxL9pOJnOsILe63qVWkU8g++20ht2PHx4QwYzjakxNV+MJnOe9kr5Y97JymizSURdNSaVMEW0s+JsL0R4IcILSYSXcb5cmitbY65bnGtDLhEjjOPnfrnEIXeGqleK/0z4wzVBNotncpqOg3iRqmCSzqJgTgvEMJrPaE7zcZyOeWmfP4ys9S1dknPamhM5XeRVIONZGMzkIgzmCzkOopHMaDJJx5mKDkLgrkxvmorUW5vTQYas0i3gl9YnC9tI+iXwBfnRUm7I+aEfvU2pLGsW9lV9EPUE/WE8WETxDwfJFf21Qa74DfcP3ZBr8m6EPxnpp8cYWRx15bAmCM5BoCLn0Qe3HBa9bYyQooBUHbiaSsEiAwszcXQlea345lK0G4U2whoSnBLiTtdbv9oNjBvcUrU+k9XGnQ/EG5PvRL0lURGMNkCGa4pCVrthQUpLDAdkaqocoGEYxRcQjO9+tuZtbKUT4IkdH+lFAUMA8kC8q6zZCDbUdfIFJwfO0BtEHk52F0JVOxjmwyHKim413TlxVyFygrIM4XMDccWGshxRyLIElIVmhXJrgtoGygKydm+IP66UKQ3ZTiRpKeEbW4nr5FqskVuszfXgui/utjoncb269to7qO+0wqky3WLbpoDh4uzOVjeexVyyoVp8+Pu/OkceJwY8gQOO46/2wxfi2o8m2twiwa5P9ref7fj54BB4TxuXCGkhT7ADrx1gYNc/nYK6rGxJVa07DPv19J7S5oCd++cAZU1K8Ftlm83W+w8042p2sWoquYaDHgPsENy3PqBuvwyyvOlZbu9eKaGLDiH57kIc1BnwVrDJJaUcQT5OG0Ul4QPOPqwTiqRiuhFnijIJhIkoDkMG7FvMcLzqxg07XvLoPmpJcLYr4SJxf6Jccn/U7kE8XCAxYHn+dDMMPG58CdBXNj/d3Jcpq8gOXLZ0wXL23yBanN0icU7DLnQmjAWBogSSghHfO+pQsHenywkJnQFF0CS9KS1nmRJ3UjP+XzZVxQ6STb0FY9c7j39eyFRuBAHqOy9RMDFciMY4ECWSrszlbmhQT4iTVhvtCt5bUdY47F0TjiQhVaE9BeMoaVhVpMma/e/dI8UNgRvyPitIG2DFKHEMZZ/B36bxEcf/K2RzjVzfpR1/P0U9ogNQnnK+O/LzWqY3rVo+Bi2DcgR1Dmf9PxK7+B/FHc39hDgO2Iaqgzx2dtEUfn7Ujsj3hxGG88PDoXZo1Ju2NjzxxUeM+Ysfk0ppRqLMv3vsz0zmjlrZbdyeZ4Fv5K3sWp0/vUb1sMzQtRW+tg8Z+C2dbtFFoFCDakvuFCpCtoA01QVzwrBLyTS3jrpEpiHWqGGbIANxWXPByFHvHWN2k9u1zK+22vXb5ADxoFghSfCJupA+wTxsFJAEUd9a8d0OwwYn4OCqBqBTy0lwscdld+xwCrwrsBjr5ctU7bmrhT/USKLRLBx26BXfodKB/rCO06LjFwm0t5kkOLM9Q7sPP/9nPkeX1DZO7thaYWJTb713J/uw/5HMfiyedFFv9v3OJwPz7lUwWaDZEMhEJbKmAl9ylfG8+fWfv3p5xZ4XZ11zPfAi+1AX/gdJoVbW6fYcq2UtfmrUBgbvbFMx8ymtOBgffv53WzgNkWK62SKy9Z1luU4UerPtdvojL796/fXJZreV4sx3CBng60kA3+Az8MawkKZBMCsA59w7ECejdYFrOdYyTQlwY6HWG4VO5YUTCKDSaY3GgVnHWNhR5jrVtSh1SVwP+sIbKRoOJm9vUcQECKjcEKq4s10ZYxewf6AxeE5I5lLYKNPKOu4egq11PIBqgSY3Z5ptSc+1rHew9JINXUPR1oDWrUC9rOjoOkAJVM1J8wkO/AXdgB5OUPEcUloTn4eKLyhHd0Axko6STUUI6FD438GxsiSgm9ZbbDxXVJv5/fuk2/sbQeFlXZ/oyxN7L9jPi8IajVxxnzB6jZJE0hxpFNGnz6B+u/NggXd9+eNWhHFK6db6aHUJcCdRWLkF+UJ/P/LtGPeqR7zOt67n9frdviVBl9td0cRZKH4j1lx36KTlQRtr14TOtmtdRqNJGIoP//yHGC1CxN2bg+SexvNpgl74by3fslGuAUZfcH1GFEG9rg5SBBK0B/I3m75fNJp7KW6H0BWo4Sh+4KtS/Fq4HH/3xbdvrlo0EBhcp212uMRnwEGrM4hBR8VdMPpdT4dQgpsgZKvcLws6//h7BBK10CrwSiIBbNvuH3q1Q9T8VbLrHK5evf76zfdXyJoKxegTsXqudoZPamccTub78Fmz6jT8HKpAgltcHpirZf1YcVaVbfS8wb5KxAuG14tD+3mOOIPounbuo6ZdiBegKzDhC6zNZYmoOdwvTI3EQUfoNPfS2uyD0dbL8y8DL5nOdN8esGrHKX+m7wq6fuJL+gLf5PmG/qQF42rNef4HhOOXG1YF1ScXklJCMJ5wyiE3nW9pg6KJEkps54nXkQjc+JEK/FW16tYFt6NkTtECzwJyGmWhimlxbA4/KvoShSulzwn+iBCsvMWtrjrRPW/w5PHt6fUbLwCmDoq0PBGQ3mD00arfHqU+3XDLncOJ6eFgNAgPszfaHB831o3GFf6EFI9yHVW3CPzvOXHlIwB3M8HmMMVelNPxPJyEM7yNLcZyntIYL0qTeBFnWShxe55E0WQajxeSonkaUZRls1k0ltFUrcfRfOEp7+EByGlbSnbmS/+OxMdO29TLpM6bFmKJafK8U7ljUv4Y1kU51MqWQRmGo+Dw8BKgBKMLAIWhwNqN7xMms8FPrrXrgR+Seg89HO4ZoOLHrBSJCrA5Bxd70KECy1Upnesuqf4NEbTfvvgdH4rmiyyYRfNxIKWMg2k2ivBfTWgR8xOh71Y9VaAbny2i8SQeT/0T5iQOY2ROb38Wy09zjfiu2taTVJcJfbgiz5luuye3XBd4kuO+swLEINiXlYdf/RczroOLOxUAAA=="
      },
      {
        "line": 32,
        "bytes": 1093,
        "sha256": "8921065615a1f51bb763828aa4e96e55405bcb451a4e9c97448ee74a95127dd8",
        "gzipBase64": "H4sIAAAAAAAC/6VUTW/cIBC991dEnJcE4w+wrz312vbUbGTN4vEujRcswEmjaP97B+9HK+VU9WABj2Hm8ebhd5bsEWOC48w6JoVseCG4bL+LsqtVV+l7LcofbMN8GKyDiXVlsWHpbUYKDxhn7yL2NuGRYmZ4mzwMrHu/RlDqCHukPSqRlkiQ8cd5woQDgXbIMXHfC2UMgKiVKBq9qysaAKWpyp0uRaWLVkBdt6qsGi1LA7oFOh38lGtAjJayu0SQ8S4hzbrHGwW/pHlJfcJfOWAdOva+dXd3W+ZfHYYvw5Z1tIgLH1WjoDaSN60ZeGVUyTW2yJtSK9SoZWPklm3Ohx0k+4Lf6IbWu2sSUUChazoMjRJcQSs4kZW8LGDEqjJyHMpbBmI72v0ScPhKVzkngGAOJKdJf0WdBcv7KSx4gWfS9bNfXMp4cQGT99MNrMUFHcFOVCVjbpmmW4J0ONd8SMf5wQ5+5rMQBb9R4GDSAhM3kGDyez7agJW6/xm927KtO5Ge4JynzpIC1NvHpw2juDn43bo60Xo+QMxtGLN7enDxFUPuPPUpZMQcIPUXm9CYYKBi/UxNTYfgl/1hddMSXL+a5Y++uh25KrXkANDweixK+oYK2yb7ICAk7LO3WVeotpRVIxt1Xxd1VUh9M8rq3P7ZuiETZot7duQJ9nQ6bdiVTCYQaG4dDn30SzCYIbv6/Mr8/5z8z/f7YH3iG/DFZiuuD/NC95IOuR50yVVTSb4bR8FHLHYtDAZVscp1sRjrssEol5lsVgeWdPBkT9aNMEXcsCVi6K3LD4p+CNTJTp5On34DM7MC0kUEAAA="
      },
      {
        "line": 35,
        "bytes": 662,
        "sha256": "332f80b2ac1f73dc39d9507f62336fbd171a62eb819d6056f875539776dd3d13",
        "gzipBase64": "H4sIAAAAAAAC/5VSwW6cMBC99ysin3FiGzCYa0+9tj1VSGhkho0TYyMYUkWr/ffOls22PfaAZN578+Z5PGdBYcaNYF5EJ4wyVmoljfuuyq5uuso9VpX5IQqR1zEkiKIrq0LQ+4IsxzdMNMzbifkF3mOGUXTnD5Zgex18npeIhKxYc6aB9jUNgWVCadBt7UcJrZtkU7ZGAoCV9aRL/sYKneWq/y6IsNEAp9/JcNv4xLXnPj089CL/TLh+GXvR8c+2y6mxDdTeSOvYt/JNKVt0KG3ZNthia6w3vSiO4gQU3vAbe4acPkz+hLKNkg04JVsHRpYaJqwqb6axvDv4nKZw2lccv+aIhwGs/jkQevpLdYzsytO64w1e+Caf857oiusbSDnHO1irGzpBiNzliqU9xrsBPR89n2hensKYF7kopeU9ggRPO0TpgSDmk5zCilXz+LLl1Is+XXi6vCkr4TgAiU43rjSVNVoV99D/MtYVYtxXHlxOvCeiq50pWX3duYHywA34sSi/4kFrXdv6cvn0C+o7lPyWAgAA"
      }
    ],
    "terminalExec": {
      "chunk_id": "d64de3",
      "wall_time_seconds": 3.5078e-05,
      "exit_code": 0,
      "original_token_count": 31,
      "output": "{\"output\":\"/tmp/idop-p001-architect-actual-catalog-fire47.json\",\"complete\":true,\"pages\":1,\"toolCount\":50,\"failure\":null}\n"
    }
  },
  "sourceSnapshot": {
    "atArchivalHead": "44c8d10268a328a1e796856579c9cc4e2826db1d",
    "files": [
      {
        "path": "packages/operator-core/lib/agent-identities/idop-p001-live-catalog.ts",
        "bytes": 6905,
        "sha256": "cc743d851ecdb43c4d126225595e91bc501a54ef824acda77ffb12872af161d7",
        "containedInHead": true
      },
      {
        "path": "packages/operator-core/lib/agent-identities/idop-p001-live-catalog.test.ts",
        "bytes": 4611,
        "sha256": "6c393fcb3bef72dc0238afa163bf18e5b7d39ef8febaea477e2f46763eb54900",
        "containedInHead": true
      },
      {
        "path": "scripts/capture-idop-p001-live-catalog.ts",
        "bytes": 1121,
        "sha256": "a92e211ea55867bfce91f296729d8dde4c855b473da436bb1fcd599fecf354ae",
        "containedInHead": true
      },
      {
        "path": "packages/operator-core/lib/agent-mcp-client.ts",
        "bytes": 7411,
        "sha256": "8dbb99ef50be85abfb5c2c38c3f748c715057990e01ee06d8c677807dc342101",
        "containedInHead": true
      },
      {
        "path": "apps/operator/scripts/ptool.mjs",
        "bytes": 250109,
        "sha256": "8b002b1c55ffb4ec7229cd153ce76a48f65d7d2e24658e9100e0681435052bf5",
        "containedInHead": true
      },
      {
        "path": "packages/operator-core/lib/role-codex-home.ts",
        "bytes": 115874,
        "sha256": "fc411f601bbcdbba68da8fd90289c3f5d5a1929845adea2e2f5c7fdb803ca6d7",
        "containedInHead": true
      },
      {
        "path": "apps/operator/scripts/psu-launcher.mjs",
        "bytes": 917558,
        "sha256": "59338cbbcd00a5b114aa4c123deb73e14b834dc768cb776f73cde18d7fe45404",
        "containedInHead": true
      }
    ],
    "qualification": "Current archival snapshot; no pre-execution source digest was emitted by this first CLI edition. Unit test run local/untracked; four infrastructure child substitutions. No clean-committed-run claim."
  },
  "verificationLogs": [
    {
      "path": "/tmp/idop-fire47-live-catalog-tests-final.log",
      "bytes": 26051,
      "sha256": "df9548e44fb23245ed6612c5422d44fba1c7d986e1879c574bf18c0cf5c3535a",
      "gzipBase64": "H4sIAAAAAAAC/+1d3W7byBW+91MMhAVqo6FMSpQoqtWiii0nKmzLsOQF0jgwhuRQ4poiuRzSXm9goO/QXrW96LPtk/Q7Q0qWncT/Sbs1c2Gb5MycM+dvzvB8nKx9z/6U8ESkbp7wYLP8UybaPI7iVCTxn/S6XjdYJmTW9YNQrH3P9kfbg5PRwWQ42h/3apoWzJM4zXrfrSfnHtMONjalmwZJJjfDwNl04/k8yDLhaTLOU1doYcw9kdbnP8rvPq6O1P09+271+rLGDrZO3g76P7w7ORxMDt+dHBwOBnsl2ebVw/L2SX9nMjhE0/72u55x9Xhr1N8djLcGPZ05XM7YgrnE1WaCn13UcS+KPcEWE2H1+05gOVaUzLUgkhkPQ01yX6iHmiZ+Fq6WR2iNTu4p7jyZEulBIz1IdTvh7imfCrkZQ288i1PNhdbUaLgdZVrg4WeQBWgSeHGiJbpuaGFwJjSXg914WqcR65lcW3u/kMgHlopQcCnYlGeCBZL9+Wj7zXD/DVtPZrjdk3mQiQ3261//zlQHJsM4k8wN+TwRHsti1qAfp0Ik1MBL43jO/DhlAVoFMg55FsQRqGhpHrH1wVAz7KbR0lvtRtMwTdu0Ghv1Kw2+6U8G0Ot4cPgDaTEMfAwzeTscs63d/t4BG+3vvlPMXMQ5k1kQhuynXORCkeSKOeaIWRB5LI8wNUzKKxkHfVlnk5j+YDujraPxYJtNBuPJmJ0H2SzOs2KoIJoynjHo9xXLIRgSGu51qdtHpvTRZe/r9foHdvmKnc8CF4aW8PNIsmwmWIqBRMq8IBVuFl4wDlYyfiok7IFxbx5ISQLJAvdUZEogDb2hm4Zt6R2r3TYazdZGfVVBiimvnKAfw2NJ7mCKhTwSxZTXwS0z1N/rcoM5ubwodJYEHrNM3bYssMoDmgjLE9JYU5erVFZk6bF1oyUZhJeA1KtrYyjt94yNa12JA+7+lGPKnqIK70gVqVTwkJ3H6ena/sHeyXB/POnv7p6M+zsDNs156pVtYPnd/113Yesw6qy3OYvnYnPOUznTYt8PXLF5FU01miSs4OqmTF4xigS91YBh2cI0OkbLctp8Y42M72RnuDvAj/3+7vAvfQp47GMNEq91LavTtvVXNfccF7XPT6f2qqbcFA2m8ZlII5IQCR8PSv3tyVrXuHxeWu4sCD9LqHG5tjXa2xtOJoPtk/Ho6HBrwGTuwLiynDxRpu4mRcqcgoLmiYwHoYSIu8p1SIZkEVkqBBzI90UqmZ8ioCA4bMP4YtVsaQzMuYCKWMojFkRFlEjS2BVSsjiC660ryy2mxqDs9OILxrLxB7jWomuQFfYrl2EhmyEuFhbH1s8C6vs7WbggsUxcBpEb5p7wNlQ7uTodTU1HsbqihfHW6GBA69nO7vDN2wkUEZ/Wulmai1Vd7Q7x18Hh6A1C4pjYyhCRiTlMHrrqfUlVbKmTnmEylydZDt98TTwgqkKASSgwxg4JoPf+A0tERL64vM6CucDMqXtDxz8mfg6yMcjnsle2ZTKYRjxcXoZcZqM8S/JsN4hEL8rD8GsYHTFy3eZabbv5VezbDWMpbtCyGtZd+vGDKJCz+yuoabftGyoy2mbziVrSF/qJYiwSN5TzETPkUSRCzFVmHsbANDPxc4brRwTI2jOL3xNzrJrIrkgAnwszN9Xw7DRTAW0gmH5CtvNVLO2bkVsuErdR/CTbVnk2pQG9gty3W7j0b7VwXVsh7xebnxiW9QeH5Ue55mqUaOvPEsuRxB1Ojg5OJod9LO8LRSCTtzqQ6Rk4g6SLhVHz6RdZmZL8AbXs6HrDvi7v+wyo5KtJuvh0tJtJyGPGVl7hCgjRu4sC8vRXRac8Ka5beJ6mcVrr+jyU1+xkqz8eLMnfoAhClITgxoOzy83nS3DBRcTnxMWBhjbI5bMcebuLjBUZT8rPWdmBUR6b5nOMy76nzVGR6OQRLSdTyu9gR/iVxqFAwuUlcYCWtANKKdWLKFmfIdDKYlck0nkAs0OqPsVvSglrdwpusbpWkrshOWWQmVBRUMJOay/CBlPhK2FyvJEI6Bb213OeYUvuCMQewcBYpHb0CK/IeNwXZGWPk81LtyPlgZUVPUkylQ1RFA/FWfHys7KmZ5LRS7cr6YKHypyeKJqXbkWUMJ6hcCCKSkRlTs8ko5dpV0kqpEjPIDXBU+SZKW1KhCz3Lh5GIXlSIS4t5EsVofLFOqqIwZzkuHj1EUHeL8TWnl9uLzWuFfvjhEqOxZYYUnQgpYU3Y6MdpBAVXjPi2YsJZQ8Uy8u2Hi9PwsAlCERlP48VzMu0ICcG6kdtaEQiFNzEzVMJsMYiWC/uoyBNUAdV4J5RaoHgn74Qa3qikF52xo4U04cPKkBNKKbcLUBFIae3xzQA7aR5lqWBo3AViyR1kZpG0xeWvj+DwG61uGcoRCroibZI367XIi3btlarsOPhdYqfLcR+AkJAFXtZULxvUdKyjdaNsmTHbH1amXxkJfLL+IXHViZvAzL8+q+/sUehvYwCAgscndmZX9+O3LOaiPHvVahsWu1HjZ48oFbZaHbMV6oXXXW+XKd8SFm30Mo9SKMuWrbt1sbDN0Dt7pFvqcFuFtQfwoAXyNJb72SiZbQfS6UEG90xfqOBJgAv1rpUKP/8hMvl6ElzXuCRnsrOLSAGYFzVe417gxj0T3AMttlo/GYCBnzhKmB8USvHpJbjpV6OC8XgxvE11RzX8GihnOOldo6v1HNc6udYKei41NBxqSI1YKmk49pl7fLb4OcM3dLNbwWgAzHTurxt3XoYeM7Q2632/4gFPgRy95IM7044HxlF57+A5/sadG8D9H0Nencg+kqSh2VcB34kj4Ksy64+/lFI6IKoNj/L9M7sF1sz66qe8gfk12exW1TohttdZjZt4XR4x9ENbppNq2MIr+P4utW0Wwbn7btXNsO0W1crG2H+Cyw/8U1Xo4SIgfOPNTnjjVYbrTrC8G3Da/jcabasptvyTN8FB75l+r5pdXyr6Zi275gtV7f9tuN5Hd70vaZvc9cy3RaGVvBrOIHZxIKITSf2Abh8v/yiqfbhElwBmd5Pp2fXiIumo7um2bA7vmu4YJ/7jm+6Hdtu+47dMBsWB6ZfmG3Tduym6XJM0LYNx+q0Gk6ntUJcv0b6w+WD84AXLq07vyygr2uiwqDpYx+NvmlD2pV+5Q8MCi2VHxiQVk7msZdjwdgsvhUof/23PjT4zaM1l51+O24AYegtbjl22zA9t21YfqMpbJCyO8JuNeymbmFf4rhuB7mKaYBJo2Fbht1qt7ljWSvEDcu+STwV6lMrtNGwGiA/KSb/iIBS4V4r3Ov/Ne4VYf1w8nrQn1ztB7aQN2HfUIFjK6hHBY6twLEVOLYCx1bg2AocW4FjKyuqwLEVOLYCx1bg2AocW4FjK2hjBY6twLEVOLYCx1bg2Aoc+wBwbAWRrCCS/1cQydtAOgsUDkr6YIRH7gLf9IQBVkDhUgHL8HiOI1oJ4FZbwYX3t/eG4zGNWTTrXcG9sUrIOOq5ONk1wmmfSRrEaZBd9ADlTmSwgzn3z6aG3ssjfoYTGLlDLu8VmIetKU4wTfaC18CzLY8rHXq9xXmfWnEUqIbCdLNhtlASbtuG1WnolkF5UXrxFuEkFD0QIgek/Oeie5/OPtALv4i9YqYUtHqLWRNE4xcRTWKEtT3C2RXXgwTny3ri6sYomqJ8OKUmK+I/HB1NBoyK5oifwsN5wWqG12uAgCH+MNjv78PC6BTbnmkKxxYtAAUU/EJ4BzyboQtVLhfoEHV1GsXnETgoTstNynNuS2PuZz0c7trWDF1r2BO92TXtbrNRb7aMv6wxhTlhi3/AVi1J4llBtDhtlnWf8zBT9n57eDh5x37f3tSMDyBVvBxcskGZxX5/D2fjJjRlxh2osIC70NGugMIIIA7oBFkeXbDR5O3gkBV4F8LIFFlveYbrNOXJjCBkPAw8nqmkGAAX7O3zMGM/5oC1cLoXQx/TWXlWLhrsjyZsqXusSQJc/vqPf+OA29hnxkI2xB4dduvyFLibFb2worYsFb+rFGErOP7TwZPd0VZ/t4CcLohGsUq0UkzFDcghHOLngqCcAstAnW0FdEByprKyYlj0nycMiRr1LY4MrhOr//w7o4NuB9oPg8Pt4daEIXQddJHgHfQBdKUJMS8W5TxxNDCeqNOX4SoeVma8X5uXOZ4Uy2nSAbKinBLdBYDI5bQ6szRQKSGW6lUhUESk04nRiToswVPMCWNH3VI0f8w9VYZXx//66jjWNWUJO1j8Ah8ymNJWJ1M9ysag6ymFsteDndEhORfMUTFBNgElofGcdKuY7q6VxjUlxNMsPmd/XI7wffcZj7UuPJ2Qw58fVOU+wbRX4rGKK+rIrsLDYz4ZQX/1AvSRvdfY4dE+Y2dm3ah32HOllhj2mb6AwUgTgqApEDSDAxZZH5ptlJqlx/Rk5VHxbExxkFyDNVTwM5t0dztPi7oWa9RNE/QyIOwkssw5s3RrLgHEA5g1YTjYlS7KaNJpqkeKMcUXQe7OgjSOVIarz+XG2leI6HGBJrwtpJt23TD1KqRXIb0K6c8c0ld25m+Hu0D+Hr0eT4aTI5q1i/cmWc8ke18BAgs5V2DgIshryyDPiu8mOzhkXy+wur3bsbpfGPcWkPFzkfjcCenfjn21s7ovCfJhrtxXU/8HAiipc/zVBkwBpz9jqYU1wRGKWLi+wucG+V7xqsJTJtdV9kerSqqWjGzGyevpuxwCYRfXBbVlfCnA3OTB+F8i0muo7/rqxmAwPtqdXNsZFJJXf5YrOv4qt1fl0nZzMVlx0HJF2TTY1XaupyKKcse7tgTFNMZXwuiZTJ4G9CpDLbA9fe0/gv0bpcNlAAA="
    },
    {
      "path": "/tmp/idop-fire47-live-catalog-types-final.log",
      "bytes": 3663,
      "sha256": "3b9a794f61c0fc3e006f8e2ea7a60ba0bd966627e3476492e50cbf35300ebe39",
      "gzipBase64": "H4sIAAAAAAAC/91Xy27jNhTd+yvurgkQOpL8VqDBBKkxCJAX/JjFFEVCUbTNRCZVkorHu676AZ0uuujX5UvmUpYcO2naBPW0QLNwmEvy8j7OOTeuvYP3Gc24ZnlGxWG5NBmZK6k0z9R7r+7VfUiFtKE1rPYOpEo4GKZFZs2hsxO01+e3BgiZiJQbyCi7o1NuDhV6o1ZpwtAXno0P0YwXRIKfwgo8IhKVkczzfJKKe04YtTRV07rdjRdurHNVRctoZnPNyYuP1mpnpxej69Hw5Howvrgejo7PryClMU+jrSiA2ijwgjbxPRL0Rl4jbHXCVqve8YJPMOM0iZpN1k18PNLF1/FutCpN8Rk1agBsxtkdT1YWCHdTNPT75Gd3VXzu+/VlXVf1ZHA5HF6f9T9U+Uc+sJRTGVUIC0uvoHGTQC4TbrmeC1n+WdyjccofbzyiFtMyB2v7Quk7gwXA+kplz/k85np96/HYujL3wvINs8anjC22nh+uPXz5HZhWxpCUT8M1QYCpeVa0VCrJQU3AzjhIOq9afeRimQk5hQU1axTgIUTVnrDAqMQDLntQ0tnn+/WXHtsO/V9+eqM8/03S3+bV2sMvv4JfeXN+9sw+LFVeeqZ4WeXWIG/gZotUN/Dw828wuByPTi8+FO7AqsLLlGJ37IxaUAtpiq26o9NNqZjRzUok3JYwxfHvDHzsD74/PRkdAYaaqBWIYeH4CgvnaxNtGDf6Ox6PLsk6ALVKuXguBJDZHHQu4RnRCKmUO3o9owsBIG9RVkf/YX/w8fSkD8ZiihFljGcWa6r5Tzli6TSJkkmnO2G9mHQS2iDNVqdBujRICA/aid+etL1uO8bjJk/tpRZTIaOMywRbXKu9cZJV6b800Uhp2Jxs0S4GSVX25yOkGzZ69VbPf80I8f9khLw+OlT+MOEspYheoaQJsQbApVZpiv7mKsmdR/45SwUTNl2C4Sln2CpHKdi8CVkep8LMeLLV4NyspH0t8gV58LddZnzAJ0hBybBtkQdinimNEm9wzbVWxQLxkPPk3C01n2DDZ7jG6bryiOtWs9kGI2lmZsoeT3lpcrjcMzPqOO2eWjHAcH0vGA/hNk+muINs1mXVqHTwMyq9R/s6lAMQkqW5AxbEVGuemoLcjoGO0IuZSjlkWt1iVeowlniC2nUrnEaUT8XL4kLsTMi+I7g6vuoPTsbDq+uNemGaExTUQgBQdPI0rZhd33d1rVobglekVRYKaKGPaKx0ai+m2Coclkh/7DZ4+/BDCd4faw9/fIH+PdfLyl1xDYTDIqCeulmrUW1M8QYp3oDKYX0D0f3h+Gz0BM6bEOWfhcWUHMtzExXz/S1w//bwfFF/er2g0/YTj3QDPiHNpOGRGAWItFhvMqG0HfQ6L+jPX6A/KNEf/CP0++2g5a/x3+s2/Sf4d6b/I/5dSv7GXHc4R+QpjA1nHHUzHmFbBlMktOBbAThE4+AF/DfiAP3m0kVKSyUd4DDnyfGCLt8goCtSbk3/XVFz+3vGDgi67fDvaPqkJojiN3zVqX0F8IjSeE8OAAA="
    }
  ],
  "controls": {
    "terminalNativeExec": true,
    "callerConfigHashReplayed": true,
    "callerEndpointHashReplayed": true,
    "launchNativeOwnerJoin": true,
    "distinctToolNames": 50,
    "sdkPageCount": 1,
    "terminalCursorAbsent": true,
    "inputSchemasRetained": true,
    "maintainedUnitCasesPassed": 11,
    "unitSkipped": 0,
    "unitInfrastructureChildSubstitutions": 4,
    "finalFocusedTypeErrors": 0
  },
  "launchBoundaryDiagnosis": {
    "failedReleaseHome": "/home/marsh-office/.papercusp/su-codex-homes/session-53875",
    "releaseWriter": "d740fc3802",
    "releaseStop": "Stop: stop (no lifecycleStop)",
    "stagingWriter": "b30d5f83fa",
    "stagingStop": "Stop: [...lifecycleStop, ...stop]",
    "followup": "EI-27284332540565917",
    "disposition": "Current-build route succeeded; default release path remains version-skewed. No deploy or role-guard weakening."
  },
  "limits": [
    "Actual fresh architect configured endpoint on current-build staging; the advertised catalog is not effective handler authorization.",
    "SDK-decoded tools/list pages retained in file and paired with native invocation/terminal exec; not a raw HTTP packet capture or full model-native control partition.",
    "First CLI edition did not emit pre-execution instrument digests; archival hashes are separately labeled.",
    "No historical baseline replacement, other-role/legal-stack coverage, four-setting vault acceptance, historical authentication, independent implementation acceptance or shipment.",
    "Existing finished observers are stopped; this native session completed after the bounded sample."
  ]
}

