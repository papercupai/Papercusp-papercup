---
rel_path: "audits/parked-agent-resumption-2026-10-09/r13-two-native-original-ledger-joins-fire32-424d5.json"
updated_at: 1791865080255
_body: "content"
---

{
  "schemaVersion": "r13-two-native-original-ledger-joins-v1",
  "observedAt": "2026-10-13T04:18:00.235Z",
  "cutoff": "2026-10-10T16:00:36.515Z",
  "cohortHash": "24ff6981fd54f120f96381dd93732ec9c1bfb2101d7eec063119bf85caeb163a",
  "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-eight-warm-original-compaction-result-candidates-fire31-424d5.json",
  "nativeSourceRefs": [
    "audits/parked-agent-resumption-2026-10-09/r13-native-c7-original-compaction-lossless-fire32-424d5.json",
    "audits/parked-agent-resumption-2026-10-09/r13-native-5e-original-compaction-lossless-fire32-424d5.json"
  ],
  "rows": [
    {
      "owner": "su-c7a48b7b-f8fd-4215-aa09-5fe6bebc007c",
      "hashVerified": true,
      "requestCount": 24,
      "rows": [
        {
          "ledger": {
            "id": "34299026",
            "at": "2026-10-09 00:49:21.326+00",
            "status": "refused"
          },
          "candidates": [],
          "classification": "not-yet-recovered"
        },
        {
          "ledger": {
            "id": "34299464",
            "at": "2026-10-09 00:50:11.38+00",
            "status": "ok"
          },
          "candidates": [],
          "classification": "not-yet-recovered"
        },
        {
          "ledger": {
            "id": "34312133",
            "at": "2026-10-09 01:22:24.412+00",
            "status": "ok"
          },
          "candidates": [
            {
              "at": "2026-10-09T01:22:24.722Z",
              "requestAt": "2026-10-09T01:22:21.690Z",
              "callId": "call_3d2a762d4c864496be1d353a54f5e02b",
              "file": "/home/marsh-office/.papercusp/su-codex-homes/session-38321/sessions/2026/10/08/rollout-2026-10-08T20-50-56-01a11e24-45d9-7ab0-921a-7231bfb1c672.jsonl",
              "line": 653,
              "kind": "root-toon",
              "respawn": "queued",
              "retuned": null,
              "paired": true
            }
          ],
          "classification": "exact-time-paired-native-receipt"
        },
        {
          "ledger": {
            "id": "34324569",
            "at": "2026-10-09 01:52:47.493+00",
            "status": "ok"
          },
          "candidates": [],
          "classification": "not-yet-recovered"
        },
        {
          "ledger": {
            "id": "34331895",
            "at": "2026-10-09 02:09:44.418+00",
            "status": "ok"
          },
          "candidates": [],
          "classification": "not-yet-recovered"
        },
        {
          "ledger": {
            "id": "34345535",
            "at": "2026-10-09 02:40:22.069+00",
            "status": "ok"
          },
          "candidates": [],
          "classification": "not-yet-recovered"
        },
        {
          "ledger": {
            "id": "34360343",
            "at": "2026-10-09 03:10:14.999+00",
            "status": "ok"
          },
          "candidates": [
            {
              "at": "2026-10-09T03:10:15.861Z",
              "requestAt": "2026-10-09T03:10:13.332Z",
              "callId": "call_250dffc5b81244eb965c549e371bed27",
              "file": "/home/marsh-office/.papercusp/su-codex-homes/session-38321/sessions/2026/10/08/rollout-2026-10-08T22-40-33-01a11e88-a1fc-7971-ab6d-d5900b33d08d.jsonl",
              "line": 623,
              "kind": "root-toon",
              "respawn": "queued",
              "retuned": null,
              "paired": true
            }
          ],
          "classification": "exact-time-paired-native-receipt"
        },
        {
          "ledger": {
            "id": "34361159",
            "at": "2026-10-09 03:11:47.387+00",
            "status": "ok"
          },
          "candidates": [],
          "classification": "not-yet-recovered"
        },
        {
          "ledger": {
            "id": "34378395",
            "at": "2026-10-09 03:45:55.258+00",
            "status": "ok"
          },
          "candidates": [],
          "classification": "not-yet-recovered"
        },
        {
          "ledger": {
            "id": "34394498",
            "at": "2026-10-09 04:20:34.259+00",
            "status": "ok"
          },
          "candidates": [
            {
              "at": "2026-10-09T04:20:34.511Z",
              "requestAt": "2026-10-09T04:20:31.925Z",
              "callId": "call_615f1b0cf5ff4064a29596834e160e04",
              "file": "/home/marsh-office/.papercusp/su-codex-homes/session-38321/sessions/2026/10/08/rollout-2026-10-08T23-47-08-01a11ec5-9493-7f01-a7eb-997782c6269a.jsonl",
              "line": 641,
              "kind": "root-toon",
              "respawn": "queued",
              "retuned": null,
              "paired": true
            }
          ],
          "classification": "exact-time-paired-native-receipt"
        },
        {
          "ledger": {
            "id": "34407247",
            "at": "2026-10-09 04:44:12.488+00",
            "status": "ok"
          },
          "candidates": [
            {
              "at": "2026-10-09T04:44:13.284Z",
              "requestAt": "2026-10-09T04:44:11.504Z",
              "callId": "call_e662ea40a67540459ec71855f59caaa6",
              "file": "/home/marsh-office/.papercusp/su-codex-homes/session-38321/sessions/2026/10/09/rollout-2026-10-09T00-21-49-01a11ee5-56f0-7cb2-8b9c-dba180d81c52.jsonl",
              "line": 474,
              "kind": "root-toon",
              "respawn": "queued",
              "retuned": null,
              "paired": true
            }
          ],
          "classification": "exact-time-paired-native-receipt"
        },
        {
          "ledger": {
            "id": "34431276",
            "at": "2026-10-09 05:25:23.837+00",
            "status": "ok"
          },
          "candidates": [],
          "classification": "not-yet-recovered"
        },
        {
          "ledger": {
            "id": "34451692",
            "at": "2026-10-09 06:01:07.823+00",
            "status": "ok"
          },
          "candidates": [],
          "classification": "not-yet-recovered"
        },
        {
          "ledger": {
            "id": "34463291",
            "at": "2026-10-09 06:24:58.988+00",
            "status": "ok"
          },
          "candidates": [],
          "classification": "not-yet-recovered"
        },
        {
          "ledger": {
            "id": "34472579",
            "at": "2026-10-09 06:43:35.951+00",
            "status": "ok"
          },
          "candidates": [],
          "classification": "not-yet-recovered"
        },
        {
          "ledger": {
            "id": "34491338",
            "at": "2026-10-09 07:18:10.932+00",
            "status": "ok"
          },
          "candidates": [
            {
              "at": "2026-10-09T07:18:12.551Z",
              "requestAt": "2026-10-09T07:18:07.171Z",
              "callId": "call_51d850a40e9842859273cdcce55f621b",
              "file": "/home/marsh-office/.papercusp/su-codex-homes/session-38321/sessions/2026/10/09/rollout-2026-10-09T02-43-58-01a11f67-7c23-7662-8944-9b93691e3681.jsonl",
              "line": 553,
              "kind": "root-toon",
              "respawn": "queued",
              "retuned": null,
              "paired": true
            }
          ],
          "classification": "exact-time-paired-native-receipt"
        },
        {
          "ledger": {
            "id": "34587718",
            "at": "2026-10-09 10:36:48.797+00",
            "status": "ok"
          },
          "candidates": [
            {
              "at": "2026-10-09T10:36:49.028Z",
              "requestAt": "2026-10-09T10:36:44.123Z",
              "callId": "call_4c5e3b22b60a43c298357c7672f84b3a",
              "file": "/home/marsh-office/.papercusp/su-codex-homes/session-38321/sessions/2026/10/09/rollout-2026-10-09T03-18-50-01a11f87-613e-7763-b266-e7f1367016ee.jsonl",
              "line": 734,
              "kind": "root-toon",
              "respawn": "queued",
              "retuned": null,
              "paired": true
            }
          ],
          "classification": "exact-time-paired-native-receipt"
        },
        {
          "ledger": {
            "id": "34680072",
            "at": "2026-10-09 13:32:57.375+00",
            "status": "ok"
          },
          "candidates": [],
          "classification": "not-yet-recovered"
        },
        {
          "ledger": {
            "id": "34681303",
            "at": "2026-10-09 13:35:45.605+00",
            "status": "ok"
          },
          "candidates": [],
          "classification": "not-yet-recovered"
        },
        {
          "ledger": {
            "id": "34695228",
            "at": "2026-10-09 14:11:09.801+00",
            "status": "ok"
          },
          "candidates": [
            {
              "at": "2026-10-09T14:11:10.065Z",
              "requestAt": "2026-10-09T14:11:06.113Z",
              "callId": "call_dadecb5ee7274d7face3bb66c189c406",
              "file": "/home/marsh-office/.papercusp/su-codex-homes/session-38321/sessions/2026/10/09/rollout-2026-10-09T09-36-21-01a120e1-07c6-74b2-b489-46b85151c8f7.jsonl",
              "line": 657,
              "kind": "root-toon",
              "respawn": "queued",
              "retuned": null,
              "paired": true
            }
          ],
          "classification": "exact-time-paired-native-receipt"
        },
        {
          "ledger": {
            "id": "34712508",
            "at": "2026-10-09 14:41:47.341+00",
            "status": "ok"
          },
          "candidates": [
            {
              "at": "2026-10-09T14:41:50.206Z",
              "requestAt": "2026-10-09T14:41:46.393Z",
              "callId": "call_1f5b3f2ebdb84384b456aa608e7bf31e",
              "file": "/home/marsh-office/.papercusp/su-codex-homes/session-38321/sessions/2026/10/09/rollout-2026-10-09T10-11-26-01a12101-2720-70d2-93e9-4a090ea0cf4f.jsonl",
              "line": 478,
              "kind": "root-toon",
              "respawn": "queued",
              "retuned": null,
              "paired": true
            }
          ],
          "classification": "exact-time-paired-native-receipt"
        },
        {
          "ledger": {
            "id": "34713901",
            "at": "2026-10-09 14:44:09.192+00",
            "status": "ok"
          },
          "candidates": [],
          "classification": "not-yet-recovered"
        },
        {
          "ledger": {
            "id": "35119565",
            "at": "2026-10-10 03:56:17.801+00",
            "status": "ok"
          },
          "candidates": [
            {
              "at": "2026-10-10T03:56:18.009Z",
              "requestAt": "2026-10-10T03:56:15.868Z",
              "callId": "call_2d988ce3cceb4cb591d92bc1231e0fda",
              "file": "/home/marsh-office/.papercusp/su-codex-homes/session-38321/sessions/2026/10/09/rollout-2026-10-09T10-44-16-01a1211f-366e-7912-8e3c-b6fd172b3872.jsonl",
              "line": 1024,
              "kind": "root-toon",
              "respawn": "queued",
              "retuned": null,
              "paired": true
            }
          ],
          "classification": "exact-time-paired-native-receipt"
        },
        {
          "ledger": {
            "id": "35346666",
            "at": "2026-10-10 12:29:52.81+00",
            "status": "ok"
          },
          "candidates": [
            {
              "at": "2026-10-10T12:29:52.997Z",
              "requestAt": "2026-10-10T12:29:51.075Z",
              "callId": "call_2f3efb038c0642b29f7a32f16f627d45",
              "file": "/home/marsh-office/.papercusp/su-codex-homes/session-38321/sessions/2026/10/09/rollout-2026-10-09T23-56-35-01a123f4-9be3-7080-8df1-cd0ce2e8075b.jsonl",
              "line": 641,
              "kind": "root-toon",
              "respawn": "queued",
              "retuned": null,
              "paired": true
            }
          ],
          "classification": "exact-time-paired-native-receipt"
        }
      ]
    },
    {
      "owner": "su-5e26d68f-60b7-4d7c-b1b7-0dbf07bcc96d",
      "hashVerified": true,
      "requestCount": 42,
      "rows": [
        {
          "ledger": {
            "id": "34304640",
            "at": "2026-10-09 01:02:49.3+00",
            "status": "ok"
          },
          "candidates": [
            {
              "at": "2026-10-09T01:02:49.554Z",
              "requestAt": "2026-10-09T01:02:48.320Z",
              "callId": "call_7f580699db5f4d2392490f1e33a227c0",
              "file": "/home/marsh-office/.papercusp/su-codex-homes/session-38370/sessions/2026/10/08/rollout-2026-10-08T20-00-47-01a11df6-5c9d-7331-8a34-fbedbcdedac4.jsonl",
              "line": 1315,
              "kind": "root-toon",
              "respawn": "queued",
              "retuned": null,
              "paired": true
            }
          ],
          "classification": "exact-time-paired-native-receipt"
        },
        {
          "ledger": {
            "id": "34305153",
            "at": "2026-10-09 01:03:59.959+00",
            "status": "ok"
          },
          "candidates": [
            {
              "at": "2026-10-09T01:04:01.421Z",
              "requestAt": "2026-10-09T01:03:56.646Z",
              "callId": "call_a6cf29cc5c0c489a8878dfd4c3b9db5f",
              "file": "/home/marsh-office/.papercusp/su-codex-homes/session-38370/sessions/2026/10/08/rollout-2026-10-08T21-02-59-01a11e2f-4de4-7191-9239-40b1fa35b16d.jsonl",
              "line": 34,
              "kind": "root-toon",
              "respawn": "queued",
              "retuned": null,
              "paired": true
            }
          ],
          "classification": "exact-time-paired-native-receipt"
        },
        {
          "ledger": {
            "id": "34334147",
            "at": "2026-10-09 02:14:59.605+00",
            "status": "ok"
          },
          "candidates": [],
          "classification": "not-yet-recovered"
        },
        {
          "ledger": {
            "id": "34363632",
            "at": "2026-10-09 03:17:17.72+00",
            "status": "ok"
          },
          "candidates": [
            {
              "at": "2026-10-09T03:17:18.662Z",
              "requestAt": "2026-10-09T03:17:14.243Z",
              "callId": "call_1c630c1616d544a4ac2e66733b2d3da4",
              "file": "/home/marsh-office/.papercusp/su-codex-homes/session-38370/sessions/2026/10/08/rollout-2026-10-08T22-15-40-01a11e71-d9dd-7ad1-8bd8-6bbc30957207.jsonl",
              "line": 948,
              "kind": "root-toon",
              "respawn": "queued",
              "retuned": null,
              "paired": true
            }
          ],
          "classification": "exact-time-paired-native-receipt"
        },
        {
          "ledger": {
            "id": "34389076",
            "at": "2026-10-09 04:08:22.73+00",
            "status": "ok"
          },
          "candidates": [
            {
              "at": "2026-10-09T04:08:22.952Z",
              "requestAt": "2026-10-09T04:08:18.288Z",
              "callId": "call_b979381c9959467985f15c551817b839",
              "file": "/home/marsh-office/.papercusp/su-codex-homes/session-38370/sessions/2026/10/08/rollout-2026-10-08T23-17-41-01a11eaa-a0ba-7f02-bdf1-eceed1c21c53.jsonl",
              "line": 729,
              "kind": "root-toon",
              "respawn": "queued",
              "retuned": null,
              "paired": true
            }
          ],
          "classification": "exact-time-paired-native-receipt"
        },
        {
          "ledger": {
            "id": "34412748",
            "at": "2026-10-09 04:52:49.166+00",
            "status": "ok"
          },
          "candidates": [
            {
              "at": "2026-10-09T04:52:49.443Z",
              "requestAt": "2026-10-09T04:52:47.218Z",
              "callId": "call_691fb21800264e76983791349ceb0af0",
              "file": "/home/marsh-office/.papercusp/su-codex-homes/session-38370/sessions/2026/10/09/rollout-2026-10-09T00-08-39-01a11ed9-49e7-7232-9488-4fea1dbe21f4.jsonl",
              "line": 784,
              "kind": "root-toon",
              "respawn": "queued",
              "retuned": null,
              "paired": true
            }
          ],
          "classification": "exact-time-paired-native-receipt"
        },
        {
          "ledger": {
            "id": "34441435",
            "at": "2026-10-09 05:44:09.166+00",
            "status": "refused"
          },
          "candidates": [],
          "classification": "not-yet-recovered"
        },
        {
          "ledger": {
            "id": "34441974",
            "at": "2026-10-09 05:45:04.403+00",
            "status": "ok"
          },
          "candidates": [
            {
              "at": "2026-10-09T05:45:04.637Z",
              "requestAt": "2026-10-09T05:44:59.952Z",
              "callId": "call_b232615658ba4568824e694c1ca68749",
              "file": "/home/marsh-office/.papercusp/su-codex-homes/session-38370/sessions/2026/10/09/rollout-2026-10-09T00-52-57-01a11f01-d8e6-7710-bee3-def0221f2b1f.jsonl",
              "line": 1061,
              "kind": "root-toon",
              "respawn": "queued",
              "retuned": null,
              "paired": true
            }
          ],
          "classification": "exact-time-paired-native-receipt"
        },
        {
          "ledger": {
            "id": "34461820",
            "at": "2026-10-09 06:21:51.161+00",
            "status": "ok"
          },
          "candidates": [
            {
              "at": "2026-10-09T06:21:51.834Z",
              "requestAt": "2026-10-09T06:21:46.789Z",
              "callId": "call_30efb721ab944540b29da1cb022d5be4",
              "file": "/home/marsh-office/.papercusp/su-codex-homes/session-38370/sessions/2026/10/09/rollout-2026-10-09T01-45-33-01a11f32-02f6-74c1-9bce-e0e934a753d1.jsonl",
              "line": 721,
              "kind": "root-toon",
              "respawn": "queued",
              "retuned": null,
              "paired": true
            }
          ],
          "classification": "exact-time-paired-native-receipt"
        },
        {
          "ledger": {
            "id": "34499783",
            "at": "2026-10-09 07:36:29.607+00",
            "status": "ok"
          },
          "candidates": [],
          "classification": "not-yet-recovered"
        },
        {
          "ledger": {
            "id": "34500621",
            "at": "2026-10-09 07:38:14.576+00",
            "status": "ok"
          },
          "candidates": [
            {
              "at": "2026-10-09T07:38:14.848Z",
              "requestAt": "2026-10-09T07:38:13.112Z",
              "callId": "call_de58c7cae6e242c2adff540a6ac4cd83",
              "file": "/home/marsh-office/.papercusp/su-codex-homes/session-38370/sessions/2026/10/09/rollout-2026-10-09T03-36-58-01a11f97-ff6d-7f40-b44f-3cd9ece1f303.jsonl",
              "line": 33,
              "kind": "root-toon",
              "respawn": "queued",
              "retuned": null,
              "paired": true
            }
          ],
          "classification": "exact-time-paired-native-receipt"
        },
        {
          "ledger": {
            "id": "34504848",
            "at": "2026-10-09 07:47:09.201+00",
            "status": "ok"
          },
          "candidates": [
            {
              "at": "2026-10-09T07:47:10.119Z",
              "requestAt": "2026-10-09T07:47:04.893Z",
              "callId": "call_09dc9b5c05e04742bdf70eb3c1902f8d",
              "file": "/home/marsh-office/.papercusp/su-codex-homes/session-38370/sessions/2026/10/09/rollout-2026-10-09T03-38-23-01a11f99-4e0d-7621-a36d-de4393ff743a.jsonl",
              "line": 199,
              "kind": "root-toon",
              "respawn": "queued",
              "retuned": null,
              "paired": true
            }
          ],
          "classification": "exact-time-paired-native-receipt"
        },
        {
          "ledger": {
            "id": "34516007",
            "at": "2026-10-09 08:10:09.196+00",
            "status": "ok"
          },
          "candidates": [
            {
              "at": "2026-10-09T08:10:09.422Z",
              "requestAt": "2026-10-09T08:10:05.673Z",
              "callId": "call_d3863ed938e24800b46e1fa466bb504b",
              "file": "/home/marsh-office/.papercusp/su-codex-homes/session-38370/sessions/2026/10/09/rollout-2026-10-09T03-53-05-01a11fa6-c32b-7532-bfad-971c1387e22d.jsonl",
              "line": 332,
              "kind": "root-toon",
              "respawn": "queued",
              "retuned": null,
              "paired": true
            }
          ],
          "classification": "exact-time-paired-native-receipt"
        },
        {
          "ledger": {
            "id": "34524064",
            "at": "2026-10-09 08:26:48.412+00",
            "status": "ok"
          },
          "candidates": [],
          "classification": "not-yet-recovered"
        },
        {
          "ledger": {
            "id": "34533050",
            "at": "2026-10-09 08:45:27.046+00",
            "status": "ok"
          },
          "candidates": [],
          "classification": "not-yet-recovered"
        },
        {
          "ledger": {
            "id": "34539920",
            "at": "2026-10-09 08:59:08.777+00",
            "status": "ok"
          },
          "candidates": [
            {
              "at": "2026-10-09T08:59:09.705Z",
              "requestAt": "2026-10-09T08:59:06.704Z",
              "callId": "call_912ad2a2f0e64baea2e27dafab0d2773",
              "file": "/home/marsh-office/.papercusp/su-codex-homes/session-38370/sessions/2026/10/09/rollout-2026-10-09T04-46-20-01a11fd7-8388-7aa3-9ed5-265b40cc4f4e.jsonl",
              "line": 282,
              "kind": "root-toon",
              "respawn": "queued",
              "retuned": null,
              "paired": true
            }
          ],
          "classification": "exact-time-paired-native-receipt"
        },
        {
          "ledger": {
            "id": "34549875",
            "at": "2026-10-09 09:16:25.175+00",
            "status": "ok"
          },
          "candidates": [
            {
              "at": "2026-10-09T09:16:25.521Z",
              "requestAt": "2026-10-09T09:16:20.391Z",
              "callId": "call_9952564f21ae4d9fbe5c133f5462ea48",
              "file": "/home/marsh-office/.papercusp/su-codex-homes/session-38370/sessions/2026/10/09/rollout-2026-10-09T04-59-20-01a11fe3-6d86-7b40-a513-4619fe190a77.jsonl",
              "line": 314,
              "kind": "root-toon",
              "respawn": "queued",
              "retuned": null,
              "paired": true
            }
          ],
          "classification": "exact-time-paired-native-receipt"
        },
        {
          "ledger": {
            "id": "34555693",
            "at": "2026-10-09 09:28:08.409+00",
            "status": "refused"
          },
          "candidates": [],
          "classification": "not-yet-recovered"
        },
        {
          "ledger": {
            "id": "34555911",
            "at": "2026-10-09 09:28:36.165+00",
            "status": "ok"
          },
          "candidates": [
            {
              "at": "2026-10-09T09:28:37.672Z",
              "requestAt": "2026-10-09T09:28:32.688Z",
              "callId": "call_fd10babbc9d84da8ab3753084c8d0c65",
              "file": "/home/marsh-office/.papercusp/su-codex-homes/session-38370/sessions/2026/10/09/rollout-2026-10-09T05-16-39-01a11ff3-445e-7e81-8ee9-e73abd9b1f47.jsonl",
              "line": 329,
              "kind": "root-toon",
              "respawn": "queued",
              "retuned": null,
              "paired": true
            }
          ],
          "classification": "exact-time-paired-native-receipt"
        },
        {
          "ledger": {
            "id": "34556762",
            "at": "2026-10-09 09:30:13.943+00",
            "status": "ok"
          },
          "candidates": [
            {
              "at": "2026-10-09T09:30:15.415Z",
              "requestAt": "2026-10-09T09:30:12.978Z",
              "callId": "call_b7eaed24535c4deea70a3db0c8744bd9",
              "file": "/home/marsh-office/.papercusp/su-codex-homes/session-38370/sessions/2026/10/09/rollout-2026-10-09T05-28-46-01a11ffe-5f4c-7381-a589-7eb46dd88cd5.jsonl",
              "line": 36,
              "kind": "root-toon",
              "respawn": "queued",
              "retuned": null,
              "paired": true
            }
          ],
          "classification": "exact-time-paired-native-receipt"
        },
        {
          "ledger": {
            "id": "34566186",
            "at": "2026-10-09 09:48:48.473+00",
            "status": "ok"
          },
          "candidates": [],
          "classification": "not-yet-recovered"
        },
        {
          "ledger": {
            "id": "34574808",
            "at": "2026-10-09 10:06:57.752+00",
            "status": "ok"
          },
          "candidates": [
            {
              "at": "2026-10-09T10:06:58.046Z",
              "requestAt": "2026-10-09T10:06:53.093Z",
              "callId": "call_30ad883992b64abbb0fc2d491cc9fb7f",
              "file": "/home/marsh-office/.papercusp/su-codex-homes/session-38370/sessions/2026/10/09/rollout-2026-10-09T05-48-54-01a12010-ce8f-7db0-9570-d99b0d5a0649.jsonl",
              "line": 392,
              "kind": "root-toon",
              "respawn": "queued",
              "retuned": null,
              "paired": true
            }
          ],
          "classification": "exact-time-paired-native-receipt"
        },
        {
          "ledger": {
            "id": "34583040",
            "at": "2026-10-09 10:25:58.325+00",
            "status": "ok"
          },
          "candidates": [
            {
              "at": "2026-10-09T10:25:59.983Z",
              "requestAt": "2026-10-09T10:25:56.810Z",
              "callId": "call_e9fbf78da9a5483b95f172aa4a482e8a",
              "file": "/home/marsh-office/.papercusp/su-codex-homes/session-38370/sessions/2026/10/09/rollout-2026-10-09T06-07-22-01a12021-b594-7461-83e2-c0164fbeb70f.jsonl",
              "line": 370,
              "kind": "root-toon",
              "respawn": "queued",
              "retuned": null,
              "paired": true
            }
          ],
          "classification": "exact-time-paired-native-receipt"
        },
        {
          "ledger": {
            "id": "34591973",
            "at": "2026-10-09 10:44:31.426+00",
            "status": "ok"
          },
          "candidates": [
            {
              "at": "2026-10-09T10:44:31.643Z",
              "requestAt": "2026-10-09T10:44:29.107Z",
              "callId": "call_ef69746f827843b28519a83b39acb4e5",
              "file": "/home/marsh-office/.papercusp/su-codex-homes/session-38370/sessions/2026/10/09/rollout-2026-10-09T06-27-20-01a12033-fdc0-7011-92a8-e4c7ebad0a51.jsonl",
              "line": 339,
              "kind": "root-toon",
              "respawn": "queued",
              "retuned": null,
              "paired": true
            }
          ],
          "classification": "exact-time-paired-native-receipt"
        },
        {
          "ledger": {
            "id": "34598471",
            "at": "2026-10-09 10:57:36.853+00",
            "status": "ok"
          },
          "candidates": [
            {
              "at": "2026-10-09T10:57:37.091Z",
              "requestAt": "2026-10-09T10:57:35.856Z",
              "callId": "call_0ebd182e7091415abd01a1383e973d8e",
              "file": "/home/marsh-office/.papercusp/su-codex-homes/session-38370/sessions/2026/10/09/rollout-2026-10-09T06-44-46-01a12043-f48c-7c41-8dde-a075202ce9df.jsonl",
              "line": 333,
              "kind": "root-toon",
              "respawn": "queued",
              "retuned": null,
              "paired": true
            }
          ],
          "classification": "exact-time-paired-native-receipt"
        },
        {
          "ledger": {
            "id": "34599054",
            "at": "2026-10-09 10:59:06.493+00",
            "status": "ok"
          },
          "candidates": [],
          "classification": "not-yet-recovered"
        },
        {
          "ledger": {
            "id": "34609393",
            "at": "2026-10-09 11:18:30.429+00",
            "status": "ok"
          },
          "candidates": [],
          "classification": "not-yet-recovered"
        },
        {
          "ledger": {
            "id": "34617515",
            "at": "2026-10-09 11:34:16.825+00",
            "status": "ok"
          },
          "candidates": [],
          "classification": "not-yet-recovered"
        },
        {
          "ledger": {
            "id": "34626543",
            "at": "2026-10-09 11:49:31.641+00",
            "status": "refused"
          },
          "candidates": [],
          "classification": "not-yet-recovered"
        },
        {
          "ledger": {
            "id": "34626828",
            "at": "2026-10-09 11:50:02.698+00",
            "status": "ok"
          },
          "candidates": [
            {
              "at": "2026-10-09T11:50:04.387Z",
              "requestAt": "2026-10-09T11:49:59.388Z",
              "callId": "call_a819b79d40a6453aa31e8d20400c3706",
              "file": "/home/marsh-office/.papercusp/su-codex-homes/session-38370/sessions/2026/10/09/rollout-2026-10-09T07-34-27-01a12071-7081-7ef0-b36a-57f7ca91926a.jsonl",
              "line": 322,
              "kind": "root-toon",
              "respawn": "queued",
              "retuned": null,
              "paired": true
            }
          ],
          "classification": "exact-time-paired-native-receipt"
        },
        {
          "ledger": {
            "id": "34627964",
            "at": "2026-10-09 11:52:37.732+00",
            "status": "ok"
          },
          "candidates": [
            {
              "at": "2026-10-09T11:52:38.008Z",
              "requestAt": "2026-10-09T11:52:34.745Z",
              "callId": "call_ac0175f84df6446192b29a3886ab04a2",
              "file": "/home/marsh-office/.papercusp/su-codex-homes/session-38370/sessions/2026/10/09/rollout-2026-10-09T07-50-19-01a1207f-f682-7c02-ab04-ab77fc39dbfb.jsonl",
              "line": 43,
              "kind": "root-toon",
              "respawn": "queued",
              "retuned": null,
              "paired": true
            }
          ],
          "classification": "exact-time-paired-native-receipt"
        },
        {
          "ledger": {
            "id": "34636153",
            "at": "2026-10-09 12:07:56.18+00",
            "status": "ok"
          },
          "candidates": [
            {
              "at": "2026-10-09T12:07:57.235Z",
              "requestAt": "2026-10-09T12:07:51.901Z",
              "callId": "call_f90f092f4d9247d183e7678dbeacf1bf",
              "file": "/home/marsh-office/.papercusp/su-codex-homes/session-38370/sessions/2026/10/09/rollout-2026-10-09T07-52-45-01a12082-31dd-71e0-98fc-9a81ffcc4be3.jsonl",
              "line": 330,
              "kind": "root-toon",
              "respawn": "queued",
              "retuned": null,
              "paired": true
            }
          ],
          "classification": "exact-time-paired-native-receipt"
        },
        {
          "ledger": {
            "id": "34645040",
            "at": "2026-10-09 12:25:53.799+00",
            "status": "ok"
          },
          "candidates": [
            {
              "at": "2026-10-09T12:25:54.238Z",
              "requestAt": "2026-10-09T12:25:52.571Z",
              "callId": "call_f27037097fa4458289bc6b2057d3c735",
              "file": "/home/marsh-office/.papercusp/su-codex-homes/session-38370/sessions/2026/10/09/rollout-2026-10-09T08-08-15-01a12090-6016-7f50-b817-f16d0598b04b.jsonl",
              "line": 316,
              "kind": "root-toon",
              "respawn": "queued",
              "retuned": null,
              "paired": true
            }
          ],
          "classification": "exact-time-paired-native-receipt"
        },
        {
          "ledger": {
            "id": "34646179",
            "at": "2026-10-09 12:27:54.026+00",
            "status": "ok"
          },
          "candidates": [
            {
              "at": "2026-10-09T12:27:55.276Z",
              "requestAt": "2026-10-09T12:27:51.423Z",
              "callId": "call_e3743e6e67b94f2f89049b428c913ab5",
              "file": "/home/marsh-office/.papercusp/su-codex-homes/session-38370/sessions/2026/10/09/rollout-2026-10-09T08-26-02-01a120a0-a7d3-7230-ab97-c328189518cf.jsonl",
              "line": 37,
              "kind": "root-toon",
              "respawn": "queued",
              "retuned": null,
              "paired": true
            }
          ],
          "classification": "exact-time-paired-native-receipt"
        },
        {
          "ledger": {
            "id": "34654642",
            "at": "2026-10-09 12:43:07.271+00",
            "status": "refused"
          },
          "candidates": [],
          "classification": "not-yet-recovered"
        },
        {
          "ledger": {
            "id": "34654981",
            "at": "2026-10-09 12:43:45.434+00",
            "status": "ok"
          },
          "candidates": [
            {
              "at": "2026-10-09T12:43:45.677Z",
              "requestAt": "2026-10-09T12:43:42.362Z",
              "callId": "call_a5804005bce44b529faccca2f34e48e2",
              "file": "/home/marsh-office/.papercusp/su-codex-homes/session-38370/sessions/2026/10/09/rollout-2026-10-09T08-28-06-01a120a2-892f-7be0-91de-cca398540c52.jsonl",
              "line": 356,
              "kind": "root-toon",
              "respawn": "queued",
              "retuned": null,
              "paired": true
            }
          ],
          "classification": "exact-time-paired-native-receipt"
        },
        {
          "ledger": {
            "id": "34664794",
            "at": "2026-10-09 13:03:46.625+00",
            "status": "ok"
          },
          "candidates": [
            {
              "at": "2026-10-09T13:03:46.877Z",
              "requestAt": "2026-10-09T13:03:45.583Z",
              "callId": "call_c8d34044118e4eb7b6706ddedea71fb9",
              "file": "/home/marsh-office/.papercusp/su-codex-homes/session-38370/sessions/2026/10/09/rollout-2026-10-09T08-44-00-01a120b1-1bb5-7c63-813a-cdc2c25a1482.jsonl",
              "line": 429,
              "kind": "root-toon",
              "respawn": "queued",
              "retuned": null,
              "paired": true
            }
          ],
          "classification": "exact-time-paired-native-receipt"
        },
        {
          "ledger": {
            "id": "34675131",
            "at": "2026-10-09 13:22:58.99+00",
            "status": "ok"
          },
          "candidates": [
            {
              "at": "2026-10-09T13:22:59.516Z",
              "requestAt": "2026-10-09T13:22:56.205Z",
              "callId": "call_ad008a56789c4d9f845f27285faa2cc0",
              "file": "/home/marsh-office/.papercusp/su-codex-homes/session-38370/sessions/2026/10/09/rollout-2026-10-09T09-03-57-01a120c3-5c70-7953-8e27-10d864aaea8f.jsonl",
              "line": 319,
              "kind": "root-toon",
              "respawn": "queued",
              "retuned": null,
              "paired": true
            }
          ],
          "classification": "exact-time-paired-native-receipt"
        },
        {
          "ledger": {
            "id": "34691326",
            "at": "2026-10-09 14:03:55.975+00",
            "status": "ok"
          },
          "candidates": [],
          "classification": "not-yet-recovered"
        },
        {
          "ledger": {
            "id": "34789159",
            "at": "2026-10-09 17:11:12.81+00",
            "status": "ok"
          },
          "candidates": [
            {
              "at": "2026-10-09T17:11:14.415Z",
              "requestAt": "2026-10-09T17:11:09.791Z",
              "callId": "call_19e1dd4ebc7246a9b550bbc5b43d4982",
              "file": "/home/marsh-office/.papercusp/su-codex-homes/session-38370/sessions/2026/10/09/rollout-2026-10-09T10-04-11-01a120fa-8606-7da3-9189-05400ec6b6e6.jsonl",
              "line": 505,
              "kind": "root-toon",
              "respawn": "queued",
              "retuned": null,
              "paired": true
            }
          ],
          "classification": "exact-time-paired-native-receipt"
        },
        {
          "ledger": {
            "id": "34977998",
            "at": "2026-10-09 23:05:15.28+00",
            "status": "ok"
          },
          "candidates": [
            {
              "at": "2026-10-09T23:05:15.775Z",
              "requestAt": "2026-10-09T23:05:14.005Z",
              "callId": "call_cdbf45d60ad24116a787bf53125dfc11",
              "file": "/home/marsh-office/.papercusp/su-codex-homes/session-38370/sessions/2026/10/09/rollout-2026-10-09T13-11-22-01a121a5-e25d-7d50-a942-130065d8ef51.jsonl",
              "line": 542,
              "kind": "root-toon",
              "respawn": "queued",
              "retuned": null,
              "paired": true
            }
          ],
          "classification": "exact-time-paired-native-receipt"
        },
        {
          "ledger": {
            "id": "35117641",
            "at": "2026-10-10 03:52:20.997+00",
            "status": "ok"
          },
          "candidates": [
            {
              "at": "2026-10-10T03:52:22.015Z",
              "requestAt": "2026-10-10T03:52:20.097Z",
              "callId": "call_SdVACPeKhz62lFS3CyzUzGa8",
              "file": "/home/marsh-office/.papercusp/su-codex-homes/session-38370/sessions/2026/10/09/rollout-2026-10-09T19-05-22-01a122e9-fbb7-77d2-9452-71e6d6b33def.jsonl",
              "line": 553,
              "kind": "root-toon",
              "respawn": "queued",
              "retuned": null,
              "paired": true
            }
          ],
          "classification": "exact-time-paired-native-receipt"
        }
      ]
    }
  ],
  "limits": {
    "eligibilityAccepted": 0,
    "cutoffContinuityAccepted": 0,
    "outcomesJoined": 0,
    "queuedIsNotPerformed": true
  }
}
