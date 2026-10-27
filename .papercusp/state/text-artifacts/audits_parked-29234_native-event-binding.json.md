---
rel_path: "audits/parked-29234/native-event-binding.json"
updated_at: 1792988784532
_body: "content"
---

{
  "observedAt": "2026-10-26T04:26:24.186914+00:00",
  "3fInitialEvents": [
    {
      "ts": "2026-10-26T03:10:42.549Z",
      "kind": "quota-block-detected",
      "agent": "codex",
      "matchedPattern": "/you['’]?ve hit your usage limit/i",
      "matchedExcerpt": "nt supplies the current task state. ■ You’ve hit your usage limit. Visit https://chatgpt.com/settings/usa",
      "resetAtMs": 1793509860000
    },
    {
      "ts": "2026-10-26T03:10:46.207Z",
      "kind": "quota-block-cleared"
    },
    {
      "ts": "2026-10-26T03:10:50.047Z",
      "kind": "native-turn-failed",
      "agent": "codex",
      "nativeSessionId": "01a17583-4ef4-7ab1-815a-bafd3ef8578f",
      "phase": "failed",
      "turnStartedAt": 1792984242598,
      "lastProgressAt": 1792984249776,
      "pendingTools": 0,
      "pendingToolIds": [],
      "completedToolIds": [],
      "pendingGateTools": 0,
      "pendingGateToolIds": [],
      "completedGateToolIds": [],
      "failure": {
        "code": "usage_limit_exceeded",
        "retryable": false,
        "retryAfterMs": null,
        "atMs": 1792984249776
      },
      "observedAt": 1792984250046,
      "ownerId": "su-respawn-3f232d256dd9fc56838084bb8f959e98",
      "hostPid": 3176839,
      "childPid": 763426,
      "childGeneration": 19,
      "receivedAtMs": 1792984241082,
      "ownerInputPending": false,
      "ownerStopRequested": false
    },
    {
      "ts": "2026-10-26T03:10:50.049Z",
      "kind": "quota-block-detected",
      "agent": "codex",
      "matchedPattern": "/you['’]?ve hit your usage limit/i",
      "matchedExcerpt": "◦2•◦3•4◦•5◦•6◦7 ■ You’ve hit your usage limit. Visit https://chatgpt.com/settings/usa",
      "resetAtMs": 1793509860000
    },
    {
      "ts": "2026-10-26T03:10:52.193Z",
      "kind": "native-turn-start-unverified",
      "deliveryId": "988673",
      "childGeneration": 19,
      "reason": "native-turn-start-unverified"
    },
    {
      "ts": "2026-10-26T03:10:52.194Z",
      "kind": "gated-delivery-refused",
      "mode": "turn",
      "deliveryId": "988673",
      "deliveryIds": [
        "988673"
      ],
      "reason": "native-turn-start-unverified",
      "expectedHostStartedAt": 1792966749223,
      "hostStartedAt": 1792966749223,
      "expectedChildGeneration": 19,
      "childGeneration": 19
    },
    {
      "ts": "2026-10-26T03:10:55.273Z",
      "kind": "native-turn-start-failed",
      "deliveryId": "988673",
      "retiredDeliveryIds": [
        "988673"
      ],
      "childGeneration": 19,
      "failure": {
        "code": "usage_limit_exceeded",
        "retryable": false,
        "retryAfterMs": null,
        "atMs": 1792984249776
      }
    }
  ],
  "e503Legacy": [
    {
      "root": "/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/psu-pty",
      ".jsonExists": false,
      ".events.jsonlExists": false
    },
    {
      "root": "/home/marsh-office/.papercusp-workspaces/default/.papercusp/psu-pty",
      ".jsonExists": false,
      ".events.jsonlExists": false
    }
  ]
}
