---
rel_path: "audits/parked-29234/native-host-evidence.json"
updated_at: 1792988379287
_body: "content"
---

{
  "observedAt": "2026-10-26T04:19:39.169539+00:00",
  "positiveControl": true,
  "rows": [
    {
      "ownerId": "su-respawn-3f232d256dd9fc56838084bb8f959e98",
      "record": {
        "ownerId": "su-respawn-3f232d256dd9fc56838084bb8f959e98",
        "pid": 3176839,
        "ptyPid": 763426,
        "parked": null,
        "nativeSessionId": "01a17583-4ef4-7ab1-815a-bafd3ef8578f",
        "childGeneration": 19,
        "lastActivityAt": 1792988122811,
        "execution": {
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
          "observedAt": 1792988367284,
          "ownerId": "su-respawn-3f232d256dd9fc56838084bb8f959e98",
          "hostPid": 3176839,
          "childPid": 763426,
          "childGeneration": 19,
          "nativeSessionId": "01a17583-4ef4-7ab1-815a-bafd3ef8578f",
          "receivedAtMs": 1792984241082,
          "ownerInputPending": false,
          "ownerStopRequested": false
        }
      },
      "hostProcExists": true,
      "childProcExists": true,
      "events": [
        {
          "ts": "2026-10-26T03:18:21.947Z",
          "kind": "turn-deferred-quota-blocked",
          "mode": "turn",
          "reason": "quota-blocked"
        },
        {
          "ts": "2026-10-26T03:18:21.948Z",
          "kind": "gated-delivery-refused",
          "mode": "turn",
          "deliveryId": "988735",
          "deliveryIds": [
            "988735"
          ],
          "reason": "deferred-quota-blocked",
          "expectedHostStartedAt": null,
          "hostStartedAt": 1792966749223,
          "expectedChildGeneration": null,
          "childGeneration": 19
        },
        {
          "ts": "2026-10-26T03:19:10.910Z",
          "kind": "turn-deferred-quota-blocked",
          "mode": "turn",
          "reason": "quota-blocked"
        },
        {
          "ts": "2026-10-26T03:19:10.910Z",
          "kind": "gated-delivery-refused",
          "mode": "turn",
          "deliveryId": "988735",
          "deliveryIds": [
            "988735"
          ],
          "reason": "deferred-quota-blocked",
          "expectedHostStartedAt": 1792966749223,
          "hostStartedAt": 1792966749223,
          "expectedChildGeneration": 19,
          "childGeneration": 19
        },
        {
          "ts": "2026-10-26T03:19:56.560Z",
          "kind": "turn-deferred-quota-blocked",
          "mode": "turn",
          "reason": "quota-blocked"
        },
        {
          "ts": "2026-10-26T03:19:56.560Z",
          "kind": "gated-delivery-refused",
          "mode": "turn",
          "deliveryId": "988735",
          "deliveryIds": [
            "988735"
          ],
          "reason": "deferred-quota-blocked",
          "expectedHostStartedAt": null,
          "hostStartedAt": 1792966749223,
          "expectedChildGeneration": null,
          "childGeneration": 19
        },
        {
          "ts": "2026-10-26T03:20:49.123Z",
          "kind": "turn-deferred-quota-blocked",
          "mode": "turn",
          "reason": "quota-blocked"
        },
        {
          "ts": "2026-10-26T03:20:49.123Z",
          "kind": "gated-delivery-refused",
          "mode": "turn",
          "deliveryId": "988735",
          "deliveryIds": [
            "988735"
          ],
          "reason": "deferred-quota-blocked",
          "expectedHostStartedAt": null,
          "hostStartedAt": 1792966749223,
          "expectedChildGeneration": null,
          "childGeneration": 19
        }
      ]
    },
    {
      "ownerId": "su-respawn-e5039b26d474db3205b49ff048a3c54d",
      "recordError": "[Errno 2] No such file or directory: '/home/marsh-office/.papercusp/psu-pty/su-respawn-e5039b26d474db3205b49ff048a3c54d.json'",
      "eventError": "[Errno 2] No such file or directory: '/home/marsh-office/.papercusp/psu-pty/su-respawn-e5039b26d474db3205b49ff048a3c54d.events.jsonl'"
    }
  ]
}
