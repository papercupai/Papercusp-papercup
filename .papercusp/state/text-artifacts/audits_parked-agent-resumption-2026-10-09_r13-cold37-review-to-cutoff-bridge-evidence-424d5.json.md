---
rel_path: "audits/parked-agent-resumption-2026-10-09/r13-cold37-review-to-cutoff-bridge-evidence-424d5.json"
updated_at: 1791944808257
_body: "content"
---

{
  "schemaVersion": "r13-cold37-review-to-cutoff-bridge-evidence-v1",
  "observedAt": "2026-10-14T02:25:34Z",
  "ownerId": "su-424d5476-0b13-401a-a926-0aaa9f212391",
  "workItem": "WI-6554700010008887",
  "subject": "su-ec24b79e-fb5f-4056-847e-c1bd3edfec3a",
  "route": "approved SELF/AUTO/P-013; unchanged account/cold",
  "originalReviewAsOf": "2026-10-10T01:09:46.552Z",
  "cutoff": "2026-10-10T16:00:36.515Z",
  "sourceRefs": [
    "audits/parked-agent-resumption-2026-10-09/r13-cold36-original-budget-whole-work-source-witness-424d5.json",
    "audits/parked-agent-resumption-2026-10-09/r13-cold35-original-budget-cutoff-assignment-witness-424d5.json",
    "audits/parked-agent-resumption-2026-10-09/r13-cold34-original-budget-stop-source-witness-424d5.json"
  ],
  "completedIntervalReads": {
    "mcpLedger": {
      "rows": [],
      "positiveControl": {
        "id": "34520480",
        "tool_name": "loop:arm",
        "invoked_at": "2026-10-09 08:19:47.969+00",
        "status": "passed"
      },
      "scope": "workspace papercusp-workspace, exact coord_owner_id, review<invoked_at<=cutoff; MCP only",
      "limits": [
        "Zero MCP rows is not evidence of native inactivity or universal control continuity."
      ]
    },
    "loopTransitions": {
      "status": "fulfilled",
      "value": {
        "content": [
          {
            "type": "text",
            "text": "{\"mode\":\"query\",\"rowCount\":0,\"truncated\":false,\"fields\":[],\"elapsedMs\":122,\"rows\":[],\"positiveControl\":{\"rows\":[{\"id\":\"562822\",\"at\":\"2026-10-09 08:40:05.146013+00\",\"event\":\"disarmed\"}],\"rowCount\":1,\"truncated\":false,\"fields\":[\"id\",\"at\",\"event\"],\"status\":\"passed\"},\"absence\":{\"status\":\"verified\",\"code\":\"positive-control-passed\"}}"
          },
          {
            "type": "text",
            "text": "See also: work_items:claimable; plans:list; db:migrations; testing:runs; issues:list / work_items:get; dev:pg_active_queries; dev:pg_table_sizes; dev:pg_health"
          },
          {
            "type": "text",
            "text": "See also: tools:find (discover a tool by intent — returns names + schemas, and activates them where supported)"
          }
        ]
      }
    },
    "directAndFleetMessages": {
      "status": "fulfilled",
      "value": {
        "content": [
          {
            "type": "text",
            "text": "{\"advisory\":\"ⓘ a tool covers this read: coord:feed / coord:catch-up — audience-scoped history with membership gating, instead of raw envelope rows. Raw SQL stays correct for genuinely ad-hoc analysis (a join, a group-by, a one-off slice); this fired because the query is a plain single-table read.\",\"mode\":\"query\",\"rowCount\":0,\"truncated\":false,\"fields\":[],\"elapsedMs\":529,\"rows\":[],\"positiveControl\":{\"rows\":[{\"id\":\"23716842\",\"writer_key\":\"su-ec24b79e-fb5f-4056-847e-c1bd3edfec3a\",\"ts\":\"2026-10-09 08:08:12.122+00\"}],\"rowCount\":1,\"truncated\":false,\"fields\":[\"id\",\"writer_key\",\"ts\"],\"status\":\"passed\"},\"absence\":{\"status\":\"verified\",\"code\":\"positive-control-passed\"}}"
          },
          {
            "type": "text",
            "text": "See also: work_items:claimable; plans:list; db:migrations; testing:runs; issues:list / work_items:get; dev:pg_active_queries; dev:pg_table_sizes; dev:pg_health"
          },
          {
            "type": "text",
            "text": "See also: tools:find (discover a tool by intent — returns names + schemas, and activates them where supported)"
          }
        ]
      }
    },
    "originalSessionTextGroup": {
      "status": "fulfilled",
      "value": {
        "content": [
          {
            "type": "text",
            "text": "{\"mode\":\"query\",\"rowCount\":3,\"truncated\":false,\"fields\":[\"session_id\",\"source_kind\",\"earliest\",\"latest\"],\"elapsedMs\":322,\"rows\":[{\"session_id\":\"01a11f68-4f60-7ca3-8909-7a99793ce586\",\"source_kind\":\"codex\",\"earliest\":\"2026-10-09 06:44:55.475+00\",\"latest\":\"2026-10-09 07:06:06.074+00\"},{\"session_id\":\"01a11f7b-f621-7213-8786-f9c71671d39a\",\"source_kind\":\"codex\",\"earliest\":\"2026-10-09 07:07:06.924+00\",\"latest\":\"2026-10-09 07:51:31.446+00\"},{\"session_id\":\"01a11fa5-603e-7e21-b091-51a69f60fcac\",\"source_kind\":\"codex\",\"earliest\":\"2026-10-09 07:51:56.594+00\",\"latest\":\"2026-10-09 08:21:55.544+00\"}]}"
          },
          {
            "type": "text",
            "text": "See also: work_items:claimable; plans:list; db:migrations; testing:runs; issues:list / work_items:get; dev:pg_active_queries; dev:pg_table_sizes; dev:pg_health"
          },
          {
            "type": "text",
            "text": "See also: tools:find (discover a tool by intent — returns names + schemas, and activates them where supported)"
          }
        ]
      }
    },
    "originalSessionNativePartGroups": {
      "status": "fulfilled",
      "value": {
        "content": [
          {
            "type": "text",
            "text": "{\"mode\":\"query\",\"rowCount\":9,\"truncated\":false,\"fields\":[\"session_id\",\"source_kind\",\"part_kind\",\"earliest\",\"latest\",\"stored_parts\"],\"elapsedMs\":524,\"rows\":[{\"session_id\":\"01a11f68-4f60-7ca3-8909-7a99793ce586\",\"source_kind\":\"codex\",\"part_kind\":\"text\",\"earliest\":\"2026-10-09 06:44:55.475+00\",\"latest\":\"2026-10-09 07:06:06.074+00\",\"stored_parts\":11},{\"session_id\":\"01a11f68-4f60-7ca3-8909-7a99793ce586\",\"source_kind\":\"codex\",\"part_kind\":\"tool_result\",\"earliest\":\"2026-10-09 06:45:02.261+00\",\"latest\":\"2026-10-09 07:05:59.499+00\",\"stored_parts\":64},{\"session_id\":\"01a11f68-4f60-7ca3-8909-7a99793ce586\",\"source_kind\":\"codex\",\"part_kind\":\"tool_use\",\"earliest\":\"2026-10-09 06:45:02.178+00\",\"latest\":\"2026-10-09 07:05:56.647+00\",\"stored_parts\":64},{\"session_id\":\"01a11f7b-f621-7213-8786-f9c71671d39a\",\"source_kind\":\"codex\",\"part_kind\":\"text\",\"earliest\":\"2026-10-09 07:07:06.924+00\",\"latest\":\"2026-10-09 07:51:31.446+00\",\"stored_parts\":29},{\"session_id\":\"01a11f7b-f621-7213-8786-f9c71671d39a\",\"source_kind\":\"codex\",\"part_kind\":\"tool_result\",\"earliest\":\"2026-10-09 07:07:20.435+00\",\"latest\":\"2026-10-09 07:51:23.746+00\",\"stored_parts\":93},{\"session_id\":\"01a11f7b-f621-7213-8786-f9c71671d39a\",\"source_kind\":\"codex\",\"part_kind\":\"tool_use\",\"earliest\":\"2026-10-09 07:07:20.314+00\",\"latest\":\"2026-10-09 07:51:23.626+00\",\"stored_parts\":93},{\"session_id\":\"01a11fa5-603e-7e21-b091-51a69f60fcac\",\"source_kind\":\"codex\",\"part_kind\":\"text\",\"earliest\":\"2026-10-09 07:51:56.594+00\",\"latest\":\"2026-10-09 08:21:55.544+00\",\"stored_parts\":21},{\"session_id\":\"01a11fa5-603e-7e21-b091-51a69f60fcac\",\"source_kind\":\"codex\",\"part_kind\":\"tool_result\",\"earliest\":\"2026-10-09 07:52:12.72+00\",\"latest\":\"2026-10-09 08:21:43.72+00\",\"stored_parts\":86},{\"session_id\":\"01a11fa5-603e-7e21-b091-51a69f60fcac\",\"source_kind\":\"codex\",\"part_kind\":\"tool_use\",\"earliest\":\"2026-10-09 07:52:07.197+00\",\"latest\":\"2026-10-09 08:21:42.64+00\",\"stored_parts\":78}]}"
          },
          {
            "type": "text",
            "text": "See also: work_items:claimable; plans:list; db:migrations; testing:runs; issues:list / work_items:get; dev:pg_active_queries; dev:pg_table_sizes; dev:pg_health"
          },
          {
            "type": "text",
            "text": "See also: tools:find (discover a tool by intent — returns names + schemas, and activates them where supported)"
          }
        ]
      }
    },
    "originalControlMetadata": {
      "status": "fulfilled",
      "value": {
        "content": [
          {
            "type": "text",
            "text": "{\"advisory\":\"ⓘ a tool covers this read: activity:tool-log / dev:telemetry / dev:tool_cooccurrence — per-tool rollups (count, error rate, p50/p95) and the compact per-session call log. Raw SQL stays correct for genuinely ad-hoc analysis (a join, a group-by, a one-off slice); this fired because the query is a plain single-table read.\",\"mode\":\"query\",\"rowCount\":3,\"truncated\":false,\"fields\":[\"id\",\"tool_name\",\"invoked_at\",\"execution_revision\",\"request_path\",\"dispatcher_host\"],\"elapsedMs\":327,\"rows\":[{\"id\":\"34507162\",\"tool_name\":\"session:request-compaction\",\"invoked_at\":\"2026-10-09 07:51:14.91+00\",\"execution_revision\":{\"stateRevision\":\"1600b27dc9c0c15ddb38e274\",\"specificationRevision\":\"e0cc0602d45915597050135d2885a1d9e974682f9879f4ac939fe68dab47c7b5\"},\"request_path\":\"/api/mcp\",\"dispatcher_host\":\"127.0.0.1:3271\"},{\"id\":\"34520480\",\"tool_name\":\"loop:arm\",\"invoked_at\":\"2026-10-09 08:19:47.969+00\",\"execution_revision\":{\"stateRevision\":\"1600b27dc9c0c15ddb38e274\",\"specificationRevision\":\"e0cc0602d45915597050135d2885a1d9e974682f9879f4ac939fe68dab47c7b5\"},\"request_path\":\"/api/mcp\",\"dispatcher_host\":\"127.0.0.1:3271\"},{\"id\":\"34521410\",\"tool_name\":\"session:request-compaction\",\"invoked_at\":\"2026-10-09 08:21:32.157+00\",\"execution_revision\":{\"stateRevision\":\"1600b27dc9c0c15ddb38e274\",\"specificationRevision\":\"e0cc0602d45915597050135d2885a1d9e974682f9879f4ac939fe68dab47c7b5\"},\"request_path\":\"/api/mcp\",\"dispatcher_host\":\"127.0.0.1:3271\"}]}"
          },
          {
            "type": "text",
            "text": "See also: work_items:claimable; plans:list; db:migrations; testing:runs; issues:list / work_items:get; dev:pg_active_queries; dev:pg_table_sizes; dev:pg_health"
          },
          {
            "type": "text",
            "text": "See also: tools:find (discover a tool by intent — returns names + schemas, and activates them where supported)"
          }
        ]
      }
    }
  },
  "historicalCommittedSourceWitnesses": [
    {
      "path": "packages/operator-core/lib/harness/routines/loop-dead-man.ts",
      "commit": "127f5ea74edbd6c607741cb98ab99b321f488ffc",
      "bytes": 17482,
      "sha256": "97e4d231cf7569d2f9b7ccaf9385c8481bfdd8d135c938050449d1131429570f"
    },
    {
      "path": "packages/operator-core/lib/harness/routines/loop-cost-cap.ts",
      "commit": "166088f2c7469ec6b5e5c6f073f1025aa157976f",
      "bytes": 14584,
      "sha256": "dee4f33fad107f2f0a752c3f8e360bef5dcfb1d1561e78a417c8cd5a0df20bb7"
    },
    {
      "path": "packages/operator-core/lib/harness/routines/loop-transition-log.ts",
      "commit": "d86be6ed69d05a14b087d150864033949518a37d",
      "bytes": 16859,
      "sha256": "8dd5fe33614035620b6aff583ae2353e615d5208afcaf208da40934fe3d88d7f"
    }
  ],
  "assessment": {
    "status": "bounded-interval-evidence-added; cutoff-eligibility-review-open",
    "verified": [
      "No exact-owner MCP invocations in review-to-cutoff window; known arm row positive control passed.",
      "No target-owner loop transitions in that window; actual original disarm row positive control passed.",
      "No messages written by, directly sent to, or explicitly sent to original fleet selector in that window; original correction row positive control passed.",
      "Known original three indexed sessions have retained tool_use/tool_result/text groups; latest known session text is 2026-10-09T08:21:55.544Z.",
      "Historical committed blobs were read and hashed; this is repository custody only."
    ],
    "limitations": [
      "Control metadata has execution policy revision and dispatcher host 127.0.0.1:3271; these are not loaded build/source hashes.",
      "Native part groups are for three already-known session IDs and do not prove no additional sessions or native files.",
      "Message selector coverage excludes broadcast and indirect audiences; cannot claim every owner/fleet control was checked.",
      "All original data and terminal item status preserved; no work on terminal EI-25477838487191856.",
      "Whole-work, reachable dependency and owner-control continuity are still unfrozen; no eligibility or outcome joins."
    ]
  },
  "frictions": {
    "readOnlyCodeRun502": "EI-24802357246708467",
    "ownerTimeNativePartTimeout": "EI-24830867955538873",
    "recovery": "Narrowed the native-part read to already-known session IDs; no timeout result treated as absence."
  },
  "summary": {
    "originalPopulation": 116,
    "preservedAcceptedReceipts": 113,
    "unresolvedReceipts": 24,
    "membershipUnchanged": true,
    "continuityAccepted": 0,
    "eligibilityAccepted": 0,
    "outcomesJoined": 0,
    "newAcquisitions": 0,
    "productTestsRerun": 0
  },
  "next": [
    "Complete missing broadcast/indirect owner controls and whole-work/dependency custody over original review-to-cutoff interval.",
    "Resolve historical loaded-source pins for assignment/control writers.",
    "Freeze whole116 continuity and eligibility before joining remediation outcomes."
  ]
}
