---
rel_path: "audits/parked-agent-resumption-2026-10-09/r13-cold41-resource-writer-and-interval-disk-custody-424d5.json"
updated_at: 1791951523976
_body: "content"
---

{
  "schemaVersion": "r13-cold41-resource-writer-and-interval-disk-custody-v1",
  "ownerId": "su-424d5476-0b13-401a-a926-0aaa9f212391",
  "workItem": "WI-6554700010008887",
  "subject": "su-ec24b79e-fb5f-4056-847e-c1bd3edfec3a",
  "reviewAt": "2026-10-10T01:09:46.552Z",
  "cutoff": "2026-10-10T16:00:36.515Z",
  "route": "Same approved SELF/AUTO/P013/account/cold",
  "sourceRefs": [
    "audits/parked-agent-resumption-2026-10-09/r13-cold40-original-disk-pipeline-source-custody-424d5.json",
    "audits/parked-agent-resumption-2026-10-09/r13-cold39-dependency-scope-and-expanded-controls-424d5.json"
  ],
  "originalDiskRead": {
    "spillURI": "papercusp://scratch/papercusp-workspace/code:run/e54adf70-ccaf-42e4-aedd-2127f5b41d56/result-door-1791951401567-d55c6c52.spill",
    "byteLength": 3193,
    "sha256": "ea1c6627679f8414708abffc45ff3158991a06fda7de34595604e97f21d79700",
    "fullRead": true,
    "eof": true,
    "nextCursor": null,
    "envelope": {
      "content": [
        {
          "type": "text",
          "text": "format: toon\nok: true\nsummary:\n  args:\n    sql: \"SELECT id,created_at,title,body FROM harness_shared.attention_notifications WHERE workspace_id='papercusp-workspace' AND created_at>='2026-10-10T01:09:46.552Z' AND created_at<='2026-10-10T16:00:36.515Z' AND title LIKE 'Disk critically low%' ORDER BY created_at LIMIT 30\"\n    positiveControlSql: \"SELECT id,created_at,title FROM harness_shared.attention_notifications WHERE workspace_id='papercusp-workspace' AND created_at>='2026-10-09T00:00:00Z' AND created_at<'2026-10-10T01:09:46.552Z' AND title LIKE 'Disk critically low%' ORDER BY created_at DESC LIMIT 1\"\n    allowUnscoped: false\n    maxRows: 30\n    timeoutMs: 5000\n  result:\n    mode: query\n    rowCount: 3\n    truncated: false\n    fields[4]: id,created_at,title,body\n    elapsedMs: 16\n    rows[3]{id,created_at,title,body}:\n      \"21633\",\"2026-10-10 03:13:06.239022+00\",Disk critically low,\"/mnt/data: 41.1 GB free (0.6% of 7450.0 GB) (+1 more). Builds and writes will start failing mid-operation. Free space now.\\nDisk consumers (partial scan; largest measured; logical bytes):\\n• /home/marsh-office/.papercusp-workspaces/default: 4.5 GiB\\n• /home/marsh-office/.papercusp-workspaces/generic-test: 4.4 GiB\\n• /home/marsh-office/.papercusp-workspaces/.shared: 0.3 GiB\\n• /home/marsh-office/.papercusp-workspaces/5126-test: 0.0 GiB\\n• /home/marsh-office/.papercusp-workspaces/gsah2mqkfywwu7pd: 0.0 GiB\"\n      \"21707\",\"2026-10-10 09:13:08.61696+00\",Disk critically low,\"/mnt/data: 52.6 GB free (0.7% of 7450.0 GB) (+1 more). Builds and writes will start failing mid-operation. Free space now.\\nDisk consumers (partial scan; largest measured; logical bytes):\\n• /home/marsh-office/.papercusp-workspaces/default: 4.5 GiB\\n• /home/marsh-office/.papercusp-workspaces/generic-test: 4.5 GiB\\n• /home/marsh-office/.papercusp-workspaces/.shared: 0.3 GiB\\n• /home/marsh-office/.papercusp-workspaces/5126-test: 0.0 GiB\\n• /home/marsh-office/.papercusp-workspaces/clones: 0.0 GiB\"\n      \"21791\",\"2026-10-10 15:43:14.986342+00\",Disk critically low,\"/mnt/data: 46.6 GB free (0.6% of 7450.0 GB). Builds and writes will start failing mid-operation. Free space now.\\nDisk consumers (partial scan; largest measured; logical bytes):\\n• /home/marsh-office/.papercusp-workspaces/.shared: 0.2 GiB\\n• /home/marsh-office/.papercusp-workspaces/5126-test: 0.0 GiB\"\n    positiveControl:\n      rows[1]{id,created_at,title}:\n        \"21580\",\"2026-10-10 00:43:06.735035+00\",\"Disk critically low — worsening (tier 4: under 4.0 GB free)\"\n      rowCount: 1\n      truncated: false\n      fields[3]: id,created_at,title\n      status: passed\nlogs: []\ndryRun: false\ndispatchCount: 1\nintermediateBytes: 1992\nruntimeObservations:\n  authorizationObservationCount: 1\n  authorityWideningDetected: false\n  midTurnPromptInjectionObservability: not-observable\nplannedMutations: []\nokFalseMutations: []\nchildFailures: []\npartial: false"
        },
        {
          "type": "text",
          "text": "See also: code:tools (typed signatures for a namespace — optional pre-check); recipes:run (run a saved composed recipe instead)"
        }
      ]
    }
  },
  "immutableSource": {
    "superproject": "cf57965610",
    "gitlink": {
      "path": "libs/papercusp",
      "commit": "4a430f1e4f53f397d2687b92f3df34065aad9f7c"
    },
    "resourceLockWriter": {
      "path": "packages/locks/src/resource-lock-store.ts",
      "blob": "b490659903870c8a4750c426f57af6815932c1a6",
      "regions": [
        "240-265",
        "580-665"
      ],
      "observed": "Expired leases and releases are deleted. The immutable prior writer explicitly notes sweep removes enough information to distinguish expired-before-release from no-match. Current list returns live-or-recently-expired leases. No historical absence inference from present resource rows."
    },
    "diskAlarm": {
      "path": "packages/operator-core/lib/storage/disk-space-alarm.ts",
      "blob": "40aee9ad3952e313f6936837005458a2371823a8",
      "regions": [
        "377-447",
        "440-600"
      ],
      "observed": "statfs-based samples; GB-format body names worst path/freePct/freeBytes; toast ring is bounded; alarm escalation is best effort and title/tier-specific six-hour cooldown."
    },
    "alarmAttention": {
      "path": "packages/operator-core/lib/alarm-attention.ts",
      "blob": "b729ba84989954894a694c8ebc03d488811de496",
      "observed": "Cooldown reads attention_notifications title and created_at, then notifyAttention; no continuous sample series stored by this module."
    },
    "boundary": "These are immutable source blobs from the early serving MCP build and its gitlink. They do not establish separately loaded git-sync runner source throughout later interval."
  },
  "assessment": {
    "datedDiskObservations": "Original exact read returned three interval notifications21633/21707/21791 and positive21580; complete query rows, no truncation. Bodies identify /mnt/data, three distinct instants only. No continuous disk state or exact git object-store device match is inferred.",
    "fullerNativeOutputs": "Early routine MCP output_ref names three exact result-door objects. Four pipeline calls and two bash calls have output_ref=null. Next: inspect retained exact routine objects through capability:read, preserving source bytes and coverage; null reference does not prove no other original output.",
    "resourceHistory": "Present live-lock reader is inadequate for old leases. Historical lease history must come from saved immutable original call/native/event evidence, not current rows.",
    "eligibility": "review-open",
    "remaining": [
      "Original exact routine result-door objects retained in outputRefs read",
      "Historical runtime/loop/control/dependency custody and exact object-store device/policy history",
      "Whole116 eligibility freeze before outcome joins"
    ]
  },
  "summary": {
    "originalPopulation": 116,
    "preservedAcceptedReceipts": 113,
    "unresolvedReceipts": 24,
    "continuityAccepted": 0,
    "eligibilityAccepted": 0,
    "outcomesJoined": 0,
    "newAcquisitions": 0,
    "productTestsRerun": 0
  },
  "outputRefs": {
    "args": {
      "sql": "SELECT id,invoked_at,tool_name,output_ref,output_size,status FROM harness_shared.tool_invocations WHERE workspace_id='papercusp-workspace' AND id IN (34511241,34511782,34513633,34516144,34516205,34516620,34516670,34517537,34518630) ORDER BY invoked_at",
      "allowUnscoped": false,
      "maxRows": 9,
      "timeoutMs": 5000
    },
    "result": {
      "advisory": "ⓘ a tool covers this read: activity:tool-log / dev:telemetry / dev:tool_cooccurrence — per-tool rollups (count, error rate, p50/p95) and the compact per-session call log. Raw SQL stays correct for genuinely ad-hoc analysis (a join, a group-by, a one-off slice); this fired because the query is a plain single-table read.",
      "mode": "query",
      "rowCount": 9,
      "truncated": false,
      "fields": [
        "id",
        "invoked_at",
        "tool_name",
        "output_ref",
        "output_size",
        "status"
      ],
      "elapsedMs": 94,
      "rows": [
        {
          "id": "34511241",
          "invoked_at": "2026-10-09 08:00:36.379+00",
          "tool_name": "dev:pipeline_position",
          "output_ref": null,
          "output_size": "33241",
          "status": "ok"
        },
        {
          "id": "34511782",
          "invoked_at": "2026-10-09 08:01:45.17+00",
          "tool_name": "dev:pipeline_position",
          "output_ref": null,
          "output_size": "33239",
          "status": "ok"
        },
        {
          "id": "34513633",
          "invoked_at": "2026-10-09 08:05:19.275+00",
          "tool_name": "routines:list",
          "output_ref": "papercusp://scratch/papercusp-workspace/routines:list/f7166e6b-2d95-4f8b-ac0e-29a0d055253a/result-door-1791533119276.md",
          "output_size": "7200",
          "status": "ok"
        },
        {
          "id": "34516144",
          "invoked_at": "2026-10-09 08:10:26.796+00",
          "tool_name": "routines:list",
          "output_ref": "papercusp://scratch/papercusp-workspace/routines:list/8720c128-aced-46f1-b05b-a0de417891d7/result-door-1791533426797.md",
          "output_size": "7202",
          "status": "ok"
        },
        {
          "id": "34516205",
          "invoked_at": "2026-10-09 08:10:32.584+00",
          "tool_name": "dev:pipeline_position",
          "output_ref": null,
          "output_size": "33237",
          "status": "ok"
        },
        {
          "id": "34516620",
          "invoked_at": "2026-10-09 08:11:35.302+00",
          "tool_name": "routines:list",
          "output_ref": "papercusp://scratch/papercusp-workspace/routines:list/5be017a7-daa7-4297-990a-c8036af6df78/result-door-1791533495303.md",
          "output_size": "7200",
          "status": "ok"
        },
        {
          "id": "34516670",
          "invoked_at": "2026-10-09 08:11:40.176+00",
          "tool_name": "dev:pipeline_position",
          "output_ref": null,
          "output_size": "33235",
          "status": "ok"
        },
        {
          "id": "34517537",
          "invoked_at": "2026-10-09 08:13:34.518+00",
          "tool_name": "capability:bash",
          "output_ref": null,
          "output_size": "1985",
          "status": "ok"
        },
        {
          "id": "34518630",
          "invoked_at": "2026-10-09 08:15:32.646+00",
          "tool_name": "capability:bash",
          "output_ref": null,
          "output_size": "515",
          "status": "refused"
        }
      ]
    }
  }
}
