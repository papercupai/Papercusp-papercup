---
rel_path: "audits/parked-29234/pickup-delivery-ledger-scoped-diagnostic.json"
updated_at: 1792986014534
_body: "content"
---

{
  "mode": "query",
  "rowCount": 8,
  "truncated": false,
  "fields": [
    "id",
    "workspace_id",
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
    "payload_excerpt"
  ],
  "elapsedMs": 17,
  "rows": [
    {
      "id": "989017",
      "workspace_id": "default",
      "subscriber_id": "su-respawn-e5039b26d474db3205b49ff048a3c54d",
      "status": "delivered",
      "channel": "inbox",
      "turn_proof": null,
      "attempts": 3,
      "last_error": null,
      "source": "loop:rt_papercusp_loop_su_respawn_e5039b26d474db3205b49ff048a3c54d",
      "created_at": "2026-10-26 03:29:07.882139+00",
      "delivered_at": "2026-10-26 03:31:00.067063+00",
      "turn_started_at": null,
      "payload_excerpt": "{\"harness\": \"papercusp\", \"routineId\": \"rt_papercusp_loop_su_respawn_e5039b26d474db3205b49ff048a3c54d\", \"wakeCount\": 4}"
    },
    {
      "id": "988799",
      "workspace_id": "default",
      "subscriber_id": "su-respawn-e5039b26d474db3205b49ff048a3c54d",
      "status": "delivered",
      "channel": "inbox",
      "turn_proof": null,
      "attempts": 2,
      "last_error": null,
      "source": "loop:rt_papercusp_loop_su_respawn_e5039b26d474db3205b49ff048a3c54d",
      "created_at": "2026-10-26 03:21:32.289429+00",
      "delivered_at": "2026-10-26 03:22:24.909227+00",
      "turn_started_at": null,
      "payload_excerpt": "{\"harness\": \"papercusp\", \"routineId\": \"rt_papercusp_loop_su_respawn_e5039b26d474db3205b49ff048a3c54d\", \"wakeCount\": 3}"
    },
    {
      "id": "988736",
      "workspace_id": "default",
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
      "payload_excerpt": "{\"msg_id\": \"coord-send-ffbe8b591577d570f5ee20ed3a130958460cd71cb9a632eb44f90028c3fc1226\"}"
    },
    {
      "id": "988735",
      "workspace_id": "default",
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
      "payload_excerpt": "{\"msg_id\": \"coord-send-50f73f503088da0c6a4ad51424d43e86ab211779eda58c3292d3b18decad096d\"}"
    },
    {
      "id": "988674",
      "workspace_id": "default",
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
      "payload_excerpt": "{\"msg_id\": \"coord-send-93dfcda35b2e7df3c35767b6edf963adbdafffc924a189c3d0fcbeda46bc48bc\", \"relayProvenance\": {\"tier\": \"owner-verified-transcript\", \"quote\": \"audit all parked agents, and any agents that dont have a good reason for currently being parked, wake them and tell them to resume their work\", \"origin\": \"owner\", \"sessionId\": \"01a17453-a34b-7b63-8825-25b454e542bf\"}}"
    },
    {
      "id": "988673",
      "workspace_id": "default",
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
      "payload_excerpt": "{\"msg_id\": \"coord-send-4cccc49988b3efeb4b6b3974364afe6b56d6fdea2e94d6cfe559aa149b055132\", \"relayProvenance\": {\"tier\": \"owner-verified-transcript\", \"quote\": \"audit all parked agents, and any agents that dont have a good reason for currently being parked, wake them and tell them to resume their work\", \"origin\": \"owner\", \"sessionId\": \"01a17453-a34b-7b63-8825-25b454e542bf\"}}"
    },
    {
      "id": "988609",
      "workspace_id": "default",
      "subscriber_id": "su-respawn-e5039b26d474db3205b49ff048a3c54d",
      "status": "dropped",
      "channel": null,
      "turn_proof": null,
      "attempts": 8,
      "last_error": "loop turn delivery remained parked and exhausted 8 attempts: loop wake cannot use Channel 2 without an active loop and confirmed parked session; parked safely",
      "source": "loop:rt_papercusp_loop_su_respawn_e5039b26d474db3205b49ff048a3c54d",
      "created_at": "2026-10-26 03:08:38.492216+00",
      "delivered_at": null,
      "turn_started_at": null,
      "payload_excerpt": "{\"harness\": \"papercusp\", \"routineId\": \"rt_papercusp_loop_su_respawn_e5039b26d474db3205b49ff048a3c54d\", \"wakeCount\": 2}"
    },
    {
      "id": "988324",
      "workspace_id": "default",
      "subscriber_id": "su-respawn-e5039b26d474db3205b49ff048a3c54d",
      "status": "dropped",
      "channel": null,
      "turn_proof": null,
      "attempts": 8,
      "last_error": "loop turn delivery remained parked and exhausted 8 attempts: session ended but not safely resumable (no native session id / unsupported client) — inbox only",
      "source": "loop:rt_papercusp_loop_su_respawn_e5039b26d474db3205b49ff048a3c54d",
      "created_at": "2026-10-26 02:56:37.559626+00",
      "delivered_at": null,
      "turn_started_at": null,
      "payload_excerpt": "{\"harness\": \"papercusp\", \"routineId\": \"rt_papercusp_loop_su_respawn_e5039b26d474db3205b49ff048a3c54d\", \"wakeCount\": 1}"
    }
  ],
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
