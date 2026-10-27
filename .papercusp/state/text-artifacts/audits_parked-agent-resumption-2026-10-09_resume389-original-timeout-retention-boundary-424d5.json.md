---
rel_path: "audits/parked-agent-resumption-2026-10-09/resume389-original-timeout-retention-boundary-424d5.json"
updated_at: 1792973020056
_body: "content"
---

{
  "edition": "resume389 historical timeout retention boundary",
  "root": "EI-26709724481565713",
  "candidate": {
    "mode": "query",
    "rowCount": 0,
    "truncated": false,
    "fields": [],
    "elapsedMs": 44,
    "rows": [],
    "positiveControl": {
      "rows": [
        {
          "workflow_uuid": "sched-.routinesTick-2026-10-26T00:03:30.000Z-13",
          "name": "routineFire",
          "created_at": "1792973013640"
        }
      ],
      "rowCount": 1,
      "truncated": false,
      "fields": [
        "workflow_uuid",
        "name",
        "created_at"
      ],
      "status": "passed"
    },
    "absence": {
      "status": "verified",
      "code": "positive-control-passed"
    },
    "_meta": {
      "explicitFullRequest": true,
      "format": "json",
      "_seeAlso": [
        {
          "tool": "work_items:claimable"
        },
        {
          "tool": "plans:list"
        },
        {
          "tool": "db:migrations"
        },
        {
          "tool": "testing:runs"
        },
        {
          "tool": "issues:list / work_items:get"
        },
        {
          "tool": "dev:pg_active_queries"
        },
        {
          "tool": "dev:pg_table_sizes"
        },
        {
          "tool": "dev:pg_health"
        }
      ]
    }
  },
  "bounds": [
    {
      "boundary": "earliest",
      "workflow_uuid": "sched-.sessionArchiveReconcile-2026-10-23T22:20:00.000Z",
      "name": "sessionArchiveReconcile",
      "created_at": "1792794005016"
    },
    {
      "boundary": "latest",
      "workflow_uuid": "sched-.routinesTick-2026-10-26T00:03:30.000Z-13",
      "name": "routineFire",
      "created_at": "1792973013640"
    }
  ],
  "archivalRefs": [
    "audits/parked-agent-resumption-2026-10-09/resume236-timeout-producer-terminal-boundary-424d5.json",
    "audits/parked-agent-resumption-2026-10-09/resume258-original-timeout-lineage-424d5.json",
    "session_turn:codex:01a173cc-2625-7741-8c19-f3c70b5377a0:8"
  ],
  "journalObservation": {
    "unit": "papercusp-bg-host",
    "exactTokenWindow": [
      "@1792772400",
      "@1792782300"
    ],
    "exactTokenPattern": "4d02e089|bcf9a2c9|57405569-c444-4c6f-86f3-eecd68ffec36",
    "matched": 0,
    "positiveControlWindow": [
      "@1792781880",
      "@1792782000"
    ],
    "positiveControlPattern": "2519844|d9e349cba2",
    "positiveControlMatched": 0,
    "conclusion": "Journal absence cannot establish that the historical log or event never existed; the known historical control is unavailable too."
  },
  "conclusion": "Original inner-await and owner-to-workflow linkage remain unproven. Exact candidate not present in this currently retained dbos.workflow_status table, with positive control; earliest retained row is later than both incident fires. Do not keep querying this live table for the old row. Use preserved archival records only, and do not reopen the terminal workflow_id detector fix.",
  "testsRun": [],
  "scope": "Read-only historical investigation; no Git fire, restart, deployment, test replay or peer monitoring."
}
