---
rel_path: "audits/parked-29234/pickup-exact-request-ledger.json"
updated_at: 1792986057298
_body: "content"
---

{
  "mode": "query",
  "rowCount": 4,
  "truncated": false,
  "fields": [
    "id",
    "subscriber_id",
    "status",
    "channel",
    "turn_proof",
    "attempts",
    "last_error",
    "source",
    "created_at",
    "delivered_at",
    "turn_started_at",
    "msg_id",
    "coord_msg_id"
  ],
  "elapsedMs": 20,
  "rows": [
    {
      "id": "988736",
      "subscriber_id": "su-respawn-e5039b26d474db3205b49ff048a3c54d",
      "status": "delivered",
      "channel": "inbox",
      "turn_proof": null,
      "attempts": 1,
      "last_error": null,
      "source": "su-b28c0433-620c-47f4-bcdd-0aa1ae4cbdbe",
      "created_at": "2026-10-26 03:14:48.978861+00",
      "delivered_at": "2026-10-26 03:14:49.187077+00",
      "turn_started_at": null,
      "msg_id": "coord-send-ffbe8b591577d570f5ee20ed3a130958460cd71cb9a632eb44f90028c3fc1226",
      "coord_msg_id": null
    },
    {
      "id": "988735",
      "subscriber_id": "su-respawn-3f232d256dd9fc56838084bb8f959e98",
      "status": "delivered",
      "channel": "inbox",
      "turn_proof": null,
      "attempts": 8,
      "last_error": null,
      "source": "su-b28c0433-620c-47f4-bcdd-0aa1ae4cbdbe",
      "created_at": "2026-10-26 03:14:48.946387+00",
      "delivered_at": "2026-10-26 03:20:49.117242+00",
      "turn_started_at": null,
      "msg_id": "coord-send-50f73f503088da0c6a4ad51424d43e86ab211779eda58c3292d3b18decad096d",
      "coord_msg_id": null
    },
    {
      "id": "988674",
      "subscriber_id": "su-respawn-e5039b26d474db3205b49ff048a3c54d",
      "status": "delivered",
      "channel": "inbox",
      "turn_proof": "not-picked-up",
      "attempts": 1,
      "last_error": null,
      "source": "su-b28c0433-620c-47f4-bcdd-0aa1ae4cbdbe",
      "created_at": "2026-10-26 03:10:35.642131+00",
      "delivered_at": "2026-10-26 03:10:44.539941+00",
      "turn_started_at": null,
      "msg_id": "coord-send-93dfcda35b2e7df3c35767b6edf963adbdafffc924a189c3d0fcbeda46bc48bc",
      "coord_msg_id": null
    },
    {
      "id": "988673",
      "subscriber_id": "su-respawn-3f232d256dd9fc56838084bb8f959e98",
      "status": "delivered",
      "channel": "inbox",
      "turn_proof": null,
      "attempts": 8,
      "last_error": null,
      "source": "su-b28c0433-620c-47f4-bcdd-0aa1ae4cbdbe",
      "created_at": "2026-10-26 03:10:34.593641+00",
      "delivered_at": "2026-10-26 03:17:48.129448+00",
      "turn_started_at": null,
      "msg_id": "coord-send-4cccc49988b3efeb4b6b3974364afe6b56d6fdea2e94d6cfe559aa149b055132",
      "coord_msg_id": null
    }
  ],
  "positiveControl": {
    "rows": [
      {
        "id": "989017"
      }
    ],
    "rowCount": 1,
    "truncated": false,
    "fields": [
      "id"
    ],
    "status": "passed"
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
}
