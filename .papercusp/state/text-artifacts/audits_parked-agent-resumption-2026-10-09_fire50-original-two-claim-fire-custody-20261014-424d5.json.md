---
rel_path: "audits/parked-agent-resumption-2026-10-09/fire50-original-two-claim-fire-custody-20261014-424d5.json"
updated_at: 1792021546999
_body: "content"
---

{
  "schemaVersion": "parked-fire50-original-two-claim-fire-custody-v1",
  "workItem": "WI-6554700010008887",
  "finalCutoff": "2026-10-10T16:00:36.515Z",
  "sql": "SELECT event_key,first_fired_at,last_fired_at,last_fired_by,last_payload,fire_count FROM harness_shared.event_key_fires WHERE workspace_id='default' AND event_key IN ('work-item:claimed:EI-25286112504411834','work-item:claimed:EI-24785728669502309','claim:released:EI-25286112504411834','claim:released:EI-24785728669502309') ORDER BY event_key LIMIT 4",
  "result": {
    "mode": "query",
    "rowCount": 4,
    "truncated": false,
    "fields": [
      "event_key",
      "first_fired_at",
      "last_fired_at",
      "last_fired_by",
      "last_payload",
      "fire_count"
    ],
    "elapsedMs": 304,
    "rows": [
      {
        "event_key": "claim:released:EI-24785728669502309",
        "first_fired_at": "2026-10-10 08:48:28.920812+00",
        "last_fired_at": "2026-10-10 16:26:24.086962+00",
        "last_fired_by": "work-items",
        "last_payload": {
          "id": "EI-24785728669502309",
          "kind": "bug",
          "state": "open",
          "title": "P028 successor used an invalid named resume view",
          "harness": "papercusp",
          "payloadObservedAt": "2026-10-10T16:26:24.085Z"
        },
        "fire_count": "2"
      },
      {
        "event_key": "claim:released:EI-25286112504411834",
        "first_fired_at": "2026-10-10 04:20:50.777003+00",
        "last_fired_at": "2026-10-10 16:26:50.478179+00",
        "last_fired_by": "work-items",
        "last_payload": {
          "id": "EI-25286112504411834",
          "kind": "bug",
          "state": "open",
          "title": "Correct output binding target from plan item label to ledger work-item ID",
          "harness": "papercusp",
          "payloadObservedAt": "2026-10-10T16:26:50.477Z"
        },
        "fire_count": "2"
      },
      {
        "event_key": "work-item:claimed:EI-24785728669502309",
        "first_fired_at": "2026-10-10 08:46:45.123974+00",
        "last_fired_at": "2026-10-10 08:48:29.022663+00",
        "last_fired_by": "work-items",
        "last_payload": {
          "id": "EI-24785728669502309",
          "kind": "bug",
          "state": "open",
          "title": "P028 successor used an invalid named resume view",
          "harness": "papercusp",
          "assignee": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
          "payloadObservedAt": "2026-10-10T08:48:29.022Z"
        },
        "fire_count": "2"
      },
      {
        "event_key": "work-item:claimed:EI-25286112504411834",
        "first_fired_at": "2026-10-10 04:19:33.313076+00",
        "last_fired_at": "2026-10-10 04:20:51.034411+00",
        "last_fired_by": "work-items",
        "last_payload": {
          "id": "EI-25286112504411834",
          "kind": "bug",
          "state": "open",
          "title": "Correct output binding target from plan item label to ledger work-item ID",
          "harness": "papercusp",
          "assignee": "su-298f8b56-c687-404f-99e1-d1c1e53baf0c",
          "payloadObservedAt": "2026-10-10T04:20:51.029Z"
        },
        "fire_count": "2"
      }
    ],
    "positiveControl": {
      "rows": [
        {
          "event_key": "coord:inbox-wake:su-424d5476-0b13-401a-a926-0aaa9f212391",
          "first_fired_at": "2026-10-11 19:16:05.261262+00"
        }
      ],
      "rowCount": 1,
      "truncated": false,
      "fields": [
        "event_key",
        "first_fired_at"
      ],
      "status": "passed"
    }
  },
  "limits": [
    "Latch overwrites last payload on later fires; first/last and total are not a complete per-fire history.",
    "Claim emit is fire-and-forget; lack of latch does not prove no claim.",
    "No eligibility, continuous custody or pickup accepted."
  ]
}
