---
rel_path: "audits/held-agent-resumption-2026-10-12/auto-pickup-host-evidence-2026-10-20T11-38-39.597761+00-00.json"
updated_at: 1792496319668
_body: "content"
---

{
  "observedAt": "2026-10-20T11:38:39.597761+00:00",
  "rows": [
    {
      "owner": "su-0d52d810-afcc-4f52-8863-4a92600f9485",
      "deliveryId": "912241",
      "recordFound": true,
      "record": {
        "pid": 891922,
        "ptyPid": 893438,
        "startedAt": 1791594956947,
        "lastInputAt": null,
        "lastOutputAt": 1792495463877,
        "lastActivityAt": 1792495463877,
        "execution": {
          "phase": "settled",
          "turnStartedAt": 1792495456413,
          "lastProgressAt": 1792495463841,
          "pendingTools": 0,
          "observedAt": 1792496308363,
          "ownerId": "su-0d52d810-afcc-4f52-8863-4a92600f9485",
          "hostPid": 891922,
          "childPid": 893438,
          "childGeneration": 1,
          "receivedAtMs": 1792495452458,
          "ownerInputPending": false,
          "ownerStopRequested": false
        },
        "quotaBlocked": false,
        "caps": [
          "carry-respawn",
          "mcp-reconnect",
          "shutdown",
          "shutdown-identity",
          "quota-recovery",
          "native-turn-start"
        ],
        "hostCodeVersion": "772a859a542b1990798cbb9e3f4bd2d069531156226fe4b0a5c51733e0f6a11c",
        "bridgeTty": false,
        "launchedBy": null
      },
      "socketExists": true,
      "eventFileFound": true,
      "events": [
        {
          "kind": "turn-delivered",
          "ts": "2026-10-20T11:24:23.483Z"
        },
        {
          "kind": "duplicate-delivery-id",
          "ts": "2026-10-20T11:24:59.184Z",
          "mode": "turn"
        }
      ],
      "matchingEventsInTail": 2
    },
    {
      "owner": "su-60df5d22-d045-4660-bdbc-ff602879d3a8",
      "deliveryId": "912242",
      "recordFound": true,
      "record": {
        "pid": 334702,
        "ptyPid": 350604,
        "startedAt": 1791599928118,
        "lastInputAt": null,
        "lastOutputAt": 1792495463146,
        "lastActivityAt": 1792495463146,
        "execution": {
          "phase": "settled",
          "turnStartedAt": 1792495458088,
          "lastProgressAt": 1792495463109,
          "pendingTools": 0,
          "observedAt": 1792496319195,
          "ownerId": "su-60df5d22-d045-4660-bdbc-ff602879d3a8",
          "hostPid": 334702,
          "childPid": 350604,
          "childGeneration": 1,
          "receivedAtMs": 1792495452698,
          "ownerInputPending": false,
          "ownerStopRequested": false
        },
        "quotaBlocked": false,
        "caps": [
          "carry-respawn",
          "mcp-reconnect",
          "shutdown",
          "shutdown-identity",
          "quota-recovery",
          "native-turn-start"
        ],
        "hostCodeVersion": "772a859a542b1990798cbb9e3f4bd2d069531156226fe4b0a5c51733e0f6a11c",
        "bridgeTty": false,
        "launchedBy": null
      },
      "socketExists": true,
      "eventFileFound": true,
      "events": [
        {
          "kind": "turn-delivered",
          "ts": "2026-10-20T11:24:23.740Z"
        },
        {
          "kind": "duplicate-delivery-id",
          "ts": "2026-10-20T11:24:59.264Z",
          "mode": "turn"
        }
      ],
      "matchingEventsInTail": 2
    }
  ]
}
