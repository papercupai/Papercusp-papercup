---
rel_path: "audits/parked-agent-resumption-2026-10-09/r13-cold25-native-assessment-batch2-424d5.json"
updated_at: 1791895210733
_body: "content"
---

{
  "schemaVersion": "cold25-original-source-native-assessment-v1",
  "observedAt": "2026-10-13T12:40:07.779Z",
  "cohortHash": "24ff6981fd54f120f96381dd93732ec9c1bfb2101d7eec063119bf85caeb163a",
  "sourceRefs": [
    "audits/parked-agent-resumption-2026-10-09/r13-cold24-original137-custody-assessment-424d5.json",
    "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch2-424d5.json",
    "audits/parked-agent-resumption-2026-10-09/r13-cold25-native-analysis-instrument-424d5.json"
  ],
  "instrumentSha256": "cc0980905d0e8c57da7aef4e499baaec8f5538687eb30be1e27448cd55ea8b15",
  "method": "New validated literal aliases, conditional paths and labelled receipt analysis; exact source isolated by native session; deduplicate exact call/result pairs. All native process outcomes retained.",
  "rows": [
    {
      "request_id": "34967597",
      "owner": "su-ddb4cbf4-2581-4f7c-8d6a-efbb712bd295",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [],
      "acceptedPairCount": 0,
      "outcomeJoined": false
    },
    {
      "request_id": "34979247",
      "owner": "su-82c46308-5eb9-4237-9d2d-950d322576c4",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a122d6-ff62-75c3-a4ee-384dd3040a57",
          "callPart": 132,
          "resultPart": 133,
          "callTimestamp": "2026-10-09T23:07:09.785+00:00",
          "responseTimestamp": "2026-10-09T23:07:34.243+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": false,
          "parseErrors": 1,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        }
      ],
      "acceptedPairCount": 0,
      "outcomeJoined": false
    },
    {
      "request_id": "34980575",
      "owner": "su-ba80f2f7-46f6-4aec-b99a-21e02460933f",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a122d9-d539-7ed1-918a-41bcc5b9f9c4",
          "callPart": 111,
          "resultPart": 112,
          "callTimestamp": "2026-10-09T23:08:53.404+00:00",
          "responseTimestamp": "2026-10-09T23:08:55.701+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": false,
          "sourceComplete": false,
          "parseErrors": 0,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        },
        {
          "nativeSession": "01a122d9-d539-7ed1-918a-41bcc5b9f9c4",
          "callPart": 113,
          "resultPart": 114,
          "callTimestamp": "2026-10-09T23:09:35.497+00:00",
          "responseTimestamp": "2026-10-09T23:09:37.298+00:00",
          "mechanisms": [
            "native-wrapper"
          ],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": true,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": false,
          "parseErrors": 0,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        }
      ],
      "acceptedPairCount": 0,
      "outcomeJoined": false
    },
    {
      "request_id": "34993138",
      "owner": "su-ba80f2f7-46f6-4aec-b99a-21e02460933f",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a122ee-ee80-77b3-9aed-03658f2afb68",
          "callPart": 101,
          "resultPart": 102,
          "callTimestamp": "2026-10-09T23:32:00.831+00:00",
          "responseTimestamp": "2026-10-09T23:32:04.319+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": false,
          "parseErrors": 1,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        }
      ],
      "acceptedPairCount": 0,
      "outcomeJoined": false
    },
    {
      "request_id": "34995559",
      "owner": "su-ddb4cbf4-2581-4f7c-8d6a-efbb712bd295",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [],
      "acceptedPairCount": 0,
      "outcomeJoined": false
    },
    {
      "request_id": "34996602",
      "owner": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
      "acceptedUnique": true,
      "completeOriginalPair": true,
      "receiptState": "queued",
      "pairs": [
        {
          "nativeSession": "01a122fc-9a60-7772-8189-7fdc8cf876bb",
          "callPart": 92,
          "resultPart": 93,
          "callTimestamp": "2026-10-09T23:39:38.752+00:00",
          "responseTimestamp": "2026-10-09T23:39:40.048+00:00",
          "mechanisms": [
            "native-wrapper"
          ],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": true,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": true,
          "parseErrors": 0,
          "receiptState": "queued",
          "statusAgrees": true,
          "format": "toon",
          "requested": true,
          "respawn": "queued",
          "completeOriginalPair": true
        }
      ],
      "acceptedPairCount": 1,
      "outcomeJoined": false
    },
    {
      "request_id": "35002236",
      "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [],
      "acceptedPairCount": 0,
      "outcomeJoined": false
    },
    {
      "request_id": "35007728",
      "owner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [],
      "acceptedPairCount": 0,
      "outcomeJoined": false
    },
    {
      "request_id": "35012964",
      "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a12315-8b95-7243-8949-1b20acf248cd",
          "callPart": 115,
          "resultPart": 116,
          "callTimestamp": "2026-10-10T00:14:24.785+00:00",
          "responseTimestamp": "2026-10-10T00:14:26.232+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": false,
          "sourceComplete": false,
          "parseErrors": 3,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        }
      ],
      "acceptedPairCount": 0,
      "outcomeJoined": false
    },
    {
      "request_id": "35013188",
      "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a12315-8b95-7243-8949-1b20acf248cd",
          "callPart": 115,
          "resultPart": 116,
          "callTimestamp": "2026-10-10T00:14:24.785+00:00",
          "responseTimestamp": "2026-10-10T00:14:26.232+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": false,
          "sourceComplete": false,
          "parseErrors": 3,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        }
      ],
      "acceptedPairCount": 0,
      "outcomeJoined": false
    },
    {
      "request_id": "35013284",
      "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a12315-8b95-7243-8949-1b20acf248cd",
          "callPart": 115,
          "resultPart": 116,
          "callTimestamp": "2026-10-10T00:14:24.785+00:00",
          "responseTimestamp": "2026-10-10T00:14:26.232+00:00",
          "mechanisms": [
            "invoke"
          ],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": true,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": false,
          "parseErrors": 3,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        }
      ],
      "acceptedPairCount": 0,
      "outcomeJoined": false
    },
    {
      "request_id": "35014709",
      "owner": "su-960a52e7-9b11-42ac-8fe9-7e5e7e0da441",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a12315-a40e-7280-a1e8-9f2ac48b1d4e",
          "callPart": 170,
          "resultPart": 171,
          "callTimestamp": "2026-10-10T00:17:28.795+00:00",
          "responseTimestamp": "2026-10-10T00:17:32.072+00:00",
          "mechanisms": [
            "native-wrapper"
          ],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": true,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": false,
          "parseErrors": 0,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        }
      ],
      "acceptedPairCount": 0,
      "outcomeJoined": false
    },
    {
      "request_id": "35015047",
      "owner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a1231e-4587-78c2-aa03-27c4229be312",
          "callPart": 94,
          "resultPart": 95,
          "callTimestamp": "2026-10-10T00:18:03.917+00:00",
          "responseTimestamp": "2026-10-10T00:18:06.073+00:00",
          "mechanisms": [
            "native-wrapper"
          ],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": true,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": false,
          "parseErrors": 0,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        }
      ],
      "acceptedPairCount": 0,
      "outcomeJoined": false
    },
    {
      "request_id": "35018210",
      "owner": "su-82c46308-5eb9-4237-9d2d-950d322576c4",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a1231e-b6d5-7ee0-8ce8-73fb43067a42",
          "callPart": 140,
          "resultPart": 141,
          "callTimestamp": "2026-10-10T00:24:39.497+00:00",
          "responseTimestamp": "2026-10-10T00:24:41.567+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": false,
          "parseErrors": 1,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        }
      ],
      "acceptedPairCount": 0,
      "outcomeJoined": false
    },
    {
      "request_id": "35020841",
      "owner": "su-449b83a8-a709-43af-9681-768dc6ac744a",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a12329-3110-7ed1-b8cd-0af91f5a7d90",
          "callPart": 133,
          "resultPart": 134,
          "callTimestamp": "2026-10-10T00:30:07.402+00:00",
          "responseTimestamp": "2026-10-10T00:30:10.049+00:00",
          "mechanisms": [
            "native-wrapper"
          ],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": true,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": true,
          "parseErrors": 0,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        }
      ],
      "acceptedPairCount": 0,
      "outcomeJoined": false
    },
    {
      "request_id": "35022684",
      "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a12329-777a-7b80-8fc3-ab01535f10ae",
          "callPart": 104,
          "resultPart": 105,
          "callTimestamp": "2026-10-10T00:33:31+00:00",
          "responseTimestamp": "2026-10-10T00:33:33.014+00:00",
          "mechanisms": [
            "native-wrapper",
            "invoke"
          ],
          "conditionalAlternatives": true,
          "chain": null,
          "literalArgsEqual": true,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": false,
          "parseErrors": 0,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        }
      ],
      "acceptedPairCount": 0,
      "outcomeJoined": false
    },
    {
      "request_id": "35023582",
      "owner": "su-960a52e7-9b11-42ac-8fe9-7e5e7e0da441",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a1232c-37f8-7e61-a664-1dbf34681ab9",
          "callPart": 108,
          "resultPart": 109,
          "callTimestamp": "2026-10-10T00:35:01.359+00:00",
          "responseTimestamp": "2026-10-10T00:35:12.91+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": false,
          "parseErrors": 1,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        }
      ],
      "acceptedPairCount": 0,
      "outcomeJoined": false
    },
    {
      "request_id": "35030923",
      "owner": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [],
      "acceptedPairCount": 0,
      "outcomeJoined": false
    },
    {
      "request_id": "35031846",
      "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
      "acceptedUnique": true,
      "completeOriginalPair": true,
      "receiptState": "queued",
      "pairs": [
        {
          "nativeSession": "01a1233d-49f6-7fb3-b489-37d80ae709a0",
          "callPart": 65,
          "resultPart": 66,
          "callTimestamp": "2026-10-10T00:50:16.169+00:00",
          "responseTimestamp": "2026-10-10T00:50:29.501+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": false,
          "sourceComplete": false,
          "parseErrors": 0,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        },
        {
          "nativeSession": "01a1233d-49f6-7fb3-b489-37d80ae709a0",
          "callPart": 67,
          "resultPart": 68,
          "callTimestamp": "2026-10-10T00:50:33.52+00:00",
          "responseTimestamp": "2026-10-10T00:51:04.55+00:00",
          "mechanisms": [
            "ptool-invoke-quoted-json"
          ],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": true,
          "ownerEqual": true,
          "bounds": false,
          "sourceComplete": true,
          "parseErrors": 0,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        },
        {
          "nativeSession": "01a1233d-49f6-7fb3-b489-37d80ae709a0",
          "callPart": 67,
          "resultPart": 70,
          "callTimestamp": "2026-10-10T00:50:33.52+00:00",
          "responseTimestamp": "2026-10-10T00:51:10.514+00:00",
          "mechanisms": [
            "ptool-invoke-quoted-json"
          ],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "27",
            "yieldPart": 68,
            "waitPart": 69,
            "originalCallPart": 67
          },
          "literalArgsEqual": true,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": true,
          "parseErrors": 0,
          "receiptState": "queued",
          "statusAgrees": true,
          "format": "json",
          "requested": true,
          "respawn": "queued",
          "completeOriginalPair": true
        }
      ],
      "acceptedPairCount": 1,
      "outcomeJoined": false
    },
    {
      "request_id": "35038763",
      "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [],
      "acceptedPairCount": 0,
      "outcomeJoined": false
    },
    {
      "request_id": "35039357",
      "owner": "su-449b83a8-a709-43af-9681-768dc6ac744a",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a12348-953f-7483-9589-e1a23948d6f5",
          "callPart": 138,
          "resultPart": 139,
          "callTimestamp": "2026-10-10T01:05:26.418+00:00",
          "responseTimestamp": "2026-10-10T01:05:29.307+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": false,
          "parseErrors": 1,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        }
      ],
      "acceptedPairCount": 0,
      "outcomeJoined": false
    },
    {
      "request_id": "35042969",
      "owner": "su-449b83a8-a709-43af-9681-768dc6ac744a",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a12358-40b3-7071-afa8-73e105e0851b",
          "callPart": 47,
          "resultPart": 48,
          "callTimestamp": "2026-10-10T01:11:02.234+00:00",
          "responseTimestamp": "2026-10-10T01:11:04.06+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": false,
          "sourceComplete": true,
          "parseErrors": 0,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        }
      ],
      "acceptedPairCount": 0,
      "outcomeJoined": false
    }
  ],
  "sessionAssessments": [
    {
      "request_id": "34979247",
      "owner": "su-82c46308-5eb9-4237-9d2d-950d322576c4",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a122d6-ff62-75c3-a4ee-384dd3040a57",
          "callPart": 132,
          "resultPart": 133,
          "callTimestamp": "2026-10-09T23:07:09.785+00:00",
          "responseTimestamp": "2026-10-09T23:07:34.243+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": false,
          "parseErrors": 1,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        }
      ],
      "receiptState": "unresolved",
      "outcomeJoined": false
    },
    {
      "request_id": "34980575",
      "owner": "su-ba80f2f7-46f6-4aec-b99a-21e02460933f",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a122d9-d539-7ed1-918a-41bcc5b9f9c4",
          "callPart": 111,
          "resultPart": 112,
          "callTimestamp": "2026-10-09T23:08:53.404+00:00",
          "responseTimestamp": "2026-10-09T23:08:55.701+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": false,
          "sourceComplete": false,
          "parseErrors": 0,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        },
        {
          "nativeSession": "01a122d9-d539-7ed1-918a-41bcc5b9f9c4",
          "callPart": 113,
          "resultPart": 114,
          "callTimestamp": "2026-10-09T23:09:35.497+00:00",
          "responseTimestamp": "2026-10-09T23:09:37.298+00:00",
          "mechanisms": [
            "native-wrapper"
          ],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": true,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": false,
          "parseErrors": 0,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        }
      ],
      "receiptState": "unresolved",
      "outcomeJoined": false
    },
    {
      "request_id": "34993138",
      "owner": "su-ba80f2f7-46f6-4aec-b99a-21e02460933f",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a122ee-ee80-77b3-9aed-03658f2afb68",
          "callPart": 101,
          "resultPart": 102,
          "callTimestamp": "2026-10-09T23:32:00.831+00:00",
          "responseTimestamp": "2026-10-09T23:32:04.319+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": false,
          "parseErrors": 1,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        }
      ],
      "receiptState": "unresolved",
      "outcomeJoined": false
    },
    {
      "request_id": "34996602",
      "owner": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
      "completeOriginalPair": true,
      "pairs": [
        {
          "nativeSession": "01a122fc-9a60-7772-8189-7fdc8cf876bb",
          "callPart": 92,
          "resultPart": 93,
          "callTimestamp": "2026-10-09T23:39:38.752+00:00",
          "responseTimestamp": "2026-10-09T23:39:40.048+00:00",
          "mechanisms": [
            "native-wrapper"
          ],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": true,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": true,
          "parseErrors": 0,
          "receiptState": "queued",
          "statusAgrees": true,
          "format": "toon",
          "requested": true,
          "respawn": "queued",
          "completeOriginalPair": true
        }
      ],
      "receiptState": "queued",
      "outcomeJoined": false
    },
    {
      "request_id": "35012964",
      "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a12315-8b95-7243-8949-1b20acf248cd",
          "callPart": 115,
          "resultPart": 116,
          "callTimestamp": "2026-10-10T00:14:24.785+00:00",
          "responseTimestamp": "2026-10-10T00:14:26.232+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": false,
          "sourceComplete": false,
          "parseErrors": 3,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        }
      ],
      "receiptState": "unresolved",
      "outcomeJoined": false
    },
    {
      "request_id": "35013188",
      "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a12315-8b95-7243-8949-1b20acf248cd",
          "callPart": 115,
          "resultPart": 116,
          "callTimestamp": "2026-10-10T00:14:24.785+00:00",
          "responseTimestamp": "2026-10-10T00:14:26.232+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": false,
          "sourceComplete": false,
          "parseErrors": 3,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        }
      ],
      "receiptState": "unresolved",
      "outcomeJoined": false
    },
    {
      "request_id": "35013284",
      "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a12315-8b95-7243-8949-1b20acf248cd",
          "callPart": 115,
          "resultPart": 116,
          "callTimestamp": "2026-10-10T00:14:24.785+00:00",
          "responseTimestamp": "2026-10-10T00:14:26.232+00:00",
          "mechanisms": [
            "invoke"
          ],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": true,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": false,
          "parseErrors": 3,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        }
      ],
      "receiptState": "unresolved",
      "outcomeJoined": false
    },
    {
      "request_id": "35014709",
      "owner": "su-960a52e7-9b11-42ac-8fe9-7e5e7e0da441",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a12315-a40e-7280-a1e8-9f2ac48b1d4e",
          "callPart": 170,
          "resultPart": 171,
          "callTimestamp": "2026-10-10T00:17:28.795+00:00",
          "responseTimestamp": "2026-10-10T00:17:32.072+00:00",
          "mechanisms": [
            "native-wrapper"
          ],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": true,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": false,
          "parseErrors": 0,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        }
      ],
      "receiptState": "unresolved",
      "outcomeJoined": false
    },
    {
      "request_id": "35015047",
      "owner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a1231e-4587-78c2-aa03-27c4229be312",
          "callPart": 94,
          "resultPart": 95,
          "callTimestamp": "2026-10-10T00:18:03.917+00:00",
          "responseTimestamp": "2026-10-10T00:18:06.073+00:00",
          "mechanisms": [
            "native-wrapper"
          ],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": true,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": false,
          "parseErrors": 0,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        }
      ],
      "receiptState": "unresolved",
      "outcomeJoined": false
    },
    {
      "request_id": "35018210",
      "owner": "su-82c46308-5eb9-4237-9d2d-950d322576c4",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a1231e-b6d5-7ee0-8ce8-73fb43067a42",
          "callPart": 140,
          "resultPart": 141,
          "callTimestamp": "2026-10-10T00:24:39.497+00:00",
          "responseTimestamp": "2026-10-10T00:24:41.567+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": false,
          "parseErrors": 1,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        }
      ],
      "receiptState": "unresolved",
      "outcomeJoined": false
    },
    {
      "request_id": "35020841",
      "owner": "su-449b83a8-a709-43af-9681-768dc6ac744a",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a12329-3110-7ed1-b8cd-0af91f5a7d90",
          "callPart": 133,
          "resultPart": 134,
          "callTimestamp": "2026-10-10T00:30:07.402+00:00",
          "responseTimestamp": "2026-10-10T00:30:10.049+00:00",
          "mechanisms": [
            "native-wrapper"
          ],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": true,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": true,
          "parseErrors": 0,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        }
      ],
      "receiptState": "unresolved",
      "outcomeJoined": false
    },
    {
      "request_id": "35022684",
      "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a12329-777a-7b80-8fc3-ab01535f10ae",
          "callPart": 104,
          "resultPart": 105,
          "callTimestamp": "2026-10-10T00:33:31+00:00",
          "responseTimestamp": "2026-10-10T00:33:33.014+00:00",
          "mechanisms": [
            "native-wrapper",
            "invoke"
          ],
          "conditionalAlternatives": true,
          "chain": null,
          "literalArgsEqual": true,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": false,
          "parseErrors": 0,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        }
      ],
      "receiptState": "unresolved",
      "outcomeJoined": false
    },
    {
      "request_id": "35023582",
      "owner": "su-960a52e7-9b11-42ac-8fe9-7e5e7e0da441",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a1232c-37f8-7e61-a664-1dbf34681ab9",
          "callPart": 108,
          "resultPart": 109,
          "callTimestamp": "2026-10-10T00:35:01.359+00:00",
          "responseTimestamp": "2026-10-10T00:35:12.91+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": false,
          "parseErrors": 1,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        }
      ],
      "receiptState": "unresolved",
      "outcomeJoined": false
    },
    {
      "request_id": "35031846",
      "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
      "completeOriginalPair": true,
      "pairs": [
        {
          "nativeSession": "01a1233d-49f6-7fb3-b489-37d80ae709a0",
          "callPart": 65,
          "resultPart": 66,
          "callTimestamp": "2026-10-10T00:50:16.169+00:00",
          "responseTimestamp": "2026-10-10T00:50:29.501+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": false,
          "sourceComplete": false,
          "parseErrors": 0,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        },
        {
          "nativeSession": "01a1233d-49f6-7fb3-b489-37d80ae709a0",
          "callPart": 67,
          "resultPart": 68,
          "callTimestamp": "2026-10-10T00:50:33.52+00:00",
          "responseTimestamp": "2026-10-10T00:51:04.55+00:00",
          "mechanisms": [
            "ptool-invoke-quoted-json"
          ],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": true,
          "ownerEqual": true,
          "bounds": false,
          "sourceComplete": true,
          "parseErrors": 0,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        },
        {
          "nativeSession": "01a1233d-49f6-7fb3-b489-37d80ae709a0",
          "callPart": 67,
          "resultPart": 70,
          "callTimestamp": "2026-10-10T00:50:33.52+00:00",
          "responseTimestamp": "2026-10-10T00:51:10.514+00:00",
          "mechanisms": [
            "ptool-invoke-quoted-json"
          ],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "27",
            "yieldPart": 68,
            "waitPart": 69,
            "originalCallPart": 67
          },
          "literalArgsEqual": true,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": true,
          "parseErrors": 0,
          "receiptState": "queued",
          "statusAgrees": true,
          "format": "json",
          "requested": true,
          "respawn": "queued",
          "completeOriginalPair": true
        }
      ],
      "receiptState": "queued",
      "outcomeJoined": false
    },
    {
      "request_id": "35039357",
      "owner": "su-449b83a8-a709-43af-9681-768dc6ac744a",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a12348-953f-7483-9589-e1a23948d6f5",
          "callPart": 138,
          "resultPart": 139,
          "callTimestamp": "2026-10-10T01:05:26.418+00:00",
          "responseTimestamp": "2026-10-10T01:05:29.307+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": false,
          "parseErrors": 1,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        }
      ],
      "receiptState": "unresolved",
      "outcomeJoined": false
    },
    {
      "request_id": "35042969",
      "owner": "su-449b83a8-a709-43af-9681-768dc6ac744a",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a12358-40b3-7071-afa8-73e105e0851b",
          "callPart": 47,
          "resultPart": 48,
          "callTimestamp": "2026-10-10T01:11:02.234+00:00",
          "responseTimestamp": "2026-10-10T01:11:04.06+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": false,
          "sourceComplete": true,
          "parseErrors": 0,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        }
      ],
      "receiptState": "unresolved",
      "outcomeJoined": false
    }
  ],
  "executions": [
    {
      "request_id": "34979247",
      "nativeSession": "01a122d6-ff62-75c3-a4ee-384dd3040a57",
      "exitCode": 0,
      "timeout": false,
      "elapsedMs": 516,
      "inputBytes": 16503,
      "stdout": "{\"rows\":[{\"request_id\":\"34979247\",\"owner\":\"su-82c46308-5eb9-4237-9d2d-950d322576c4\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a122d6-ff62-75c3-a4ee-384dd3040a57\",\"callPart\":132,\"resultPart\":133,\"callTimestamp\":\"2026-10-09T23:07:09.785+00:00\",\"responseTimestamp\":\"2026-10-09T23:07:34.243+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":false,\"parseErrors\":1,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "34980575",
      "nativeSession": "01a122d9-d539-7ed1-918a-41bcc5b9f9c4",
      "exitCode": 0,
      "timeout": false,
      "elapsedMs": 565,
      "inputBytes": 38602,
      "stdout": "{\"rows\":[{\"request_id\":\"34980575\",\"owner\":\"su-ba80f2f7-46f6-4aec-b99a-21e02460933f\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a122d9-d539-7ed1-918a-41bcc5b9f9c4\",\"callPart\":111,\"resultPart\":112,\"callTimestamp\":\"2026-10-09T23:08:53.404+00:00\",\"responseTimestamp\":\"2026-10-09T23:08:55.701+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":false,\"sourceComplete\":false,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false},{\"nativeSession\":\"01a122d9-d539-7ed1-918a-41bcc5b9f9c4\",\"callPart\":113,\"resultPart\":114,\"callTimestamp\":\"2026-10-09T23:09:35.497+00:00\",\"responseTimestamp\":\"2026-10-09T23:09:37.298+00:00\",\"mechanisms\":[\"native-wrapper\"],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":false,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "34993138",
      "nativeSession": "01a122ee-ee80-77b3-9aed-03658f2afb68",
      "exitCode": 0,
      "timeout": false,
      "elapsedMs": 447,
      "inputBytes": 21314,
      "stdout": "{\"rows\":[{\"request_id\":\"34993138\",\"owner\":\"su-ba80f2f7-46f6-4aec-b99a-21e02460933f\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a122ee-ee80-77b3-9aed-03658f2afb68\",\"callPart\":101,\"resultPart\":102,\"callTimestamp\":\"2026-10-09T23:32:00.831+00:00\",\"responseTimestamp\":\"2026-10-09T23:32:04.319+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":false,\"parseErrors\":1,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "34996602",
      "nativeSession": "01a122fc-9a60-7772-8189-7fdc8cf876bb",
      "exitCode": 0,
      "timeout": false,
      "elapsedMs": 507,
      "inputBytes": 20825,
      "stdout": "{\"rows\":[{\"request_id\":\"34996602\",\"owner\":\"su-77348e3d-80ac-42d8-b4e7-bdce9684a72a\",\"completeOriginalPair\":true,\"pairs\":[{\"nativeSession\":\"01a122fc-9a60-7772-8189-7fdc8cf876bb\",\"callPart\":92,\"resultPart\":93,\"callTimestamp\":\"2026-10-09T23:39:38.752+00:00\",\"responseTimestamp\":\"2026-10-09T23:39:40.048+00:00\",\"mechanisms\":[\"native-wrapper\"],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"queued\",\"statusAgrees\":true,\"format\":\"toon\",\"requested\":true,\"respawn\":\"queued\",\"completeOriginalPair\":true}],\"receiptState\":\"queued\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "35012964",
      "nativeSession": "01a12315-8b95-7243-8949-1b20acf248cd",
      "exitCode": 0,
      "timeout": false,
      "elapsedMs": 472,
      "inputBytes": 31497,
      "stdout": "{\"rows\":[{\"request_id\":\"35012964\",\"owner\":\"su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a12315-8b95-7243-8949-1b20acf248cd\",\"callPart\":115,\"resultPart\":116,\"callTimestamp\":\"2026-10-10T00:14:24.785+00:00\",\"responseTimestamp\":\"2026-10-10T00:14:26.232+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":false,\"sourceComplete\":false,\"parseErrors\":3,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "35013188",
      "nativeSession": "01a12315-8b95-7243-8949-1b20acf248cd",
      "exitCode": 0,
      "timeout": false,
      "elapsedMs": 446,
      "inputBytes": 31417,
      "stdout": "{\"rows\":[{\"request_id\":\"35013188\",\"owner\":\"su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a12315-8b95-7243-8949-1b20acf248cd\",\"callPart\":115,\"resultPart\":116,\"callTimestamp\":\"2026-10-10T00:14:24.785+00:00\",\"responseTimestamp\":\"2026-10-10T00:14:26.232+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":false,\"sourceComplete\":false,\"parseErrors\":3,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "35013284",
      "nativeSession": "01a12315-8b95-7243-8949-1b20acf248cd",
      "exitCode": 0,
      "timeout": false,
      "elapsedMs": 596,
      "inputBytes": 31269,
      "stdout": "{\"rows\":[{\"request_id\":\"35013284\",\"owner\":\"su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a12315-8b95-7243-8949-1b20acf248cd\",\"callPart\":115,\"resultPart\":116,\"callTimestamp\":\"2026-10-10T00:14:24.785+00:00\",\"responseTimestamp\":\"2026-10-10T00:14:26.232+00:00\",\"mechanisms\":[\"invoke\"],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":false,\"parseErrors\":3,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "35014709",
      "nativeSession": "01a12315-a40e-7280-a1e8-9f2ac48b1d4e",
      "exitCode": 0,
      "timeout": false,
      "elapsedMs": 575,
      "inputBytes": 26924,
      "stdout": "{\"rows\":[{\"request_id\":\"35014709\",\"owner\":\"su-960a52e7-9b11-42ac-8fe9-7e5e7e0da441\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a12315-a40e-7280-a1e8-9f2ac48b1d4e\",\"callPart\":170,\"resultPart\":171,\"callTimestamp\":\"2026-10-10T00:17:28.795+00:00\",\"responseTimestamp\":\"2026-10-10T00:17:32.072+00:00\",\"mechanisms\":[\"native-wrapper\"],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":false,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "35015047",
      "nativeSession": "01a1231e-4587-78c2-aa03-27c4229be312",
      "exitCode": 0,
      "timeout": false,
      "elapsedMs": 483,
      "inputBytes": 21818,
      "stdout": "{\"rows\":[{\"request_id\":\"35015047\",\"owner\":\"su-f0e98560-52c5-4afe-8709-46fef49a576e\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a1231e-4587-78c2-aa03-27c4229be312\",\"callPart\":94,\"resultPart\":95,\"callTimestamp\":\"2026-10-10T00:18:03.917+00:00\",\"responseTimestamp\":\"2026-10-10T00:18:06.073+00:00\",\"mechanisms\":[\"native-wrapper\"],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":false,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "35018210",
      "nativeSession": "01a1231e-b6d5-7ee0-8ce8-73fb43067a42",
      "exitCode": 0,
      "timeout": false,
      "elapsedMs": 468,
      "inputBytes": 22190,
      "stdout": "{\"rows\":[{\"request_id\":\"35018210\",\"owner\":\"su-82c46308-5eb9-4237-9d2d-950d322576c4\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a1231e-b6d5-7ee0-8ce8-73fb43067a42\",\"callPart\":140,\"resultPart\":141,\"callTimestamp\":\"2026-10-10T00:24:39.497+00:00\",\"responseTimestamp\":\"2026-10-10T00:24:41.567+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":false,\"parseErrors\":1,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "35020841",
      "nativeSession": "01a12329-3110-7ed1-b8cd-0af91f5a7d90",
      "exitCode": 0,
      "timeout": false,
      "elapsedMs": 657,
      "inputBytes": 48228,
      "stdout": "{\"rows\":[{\"request_id\":\"35020841\",\"owner\":\"su-449b83a8-a709-43af-9681-768dc6ac744a\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a12329-3110-7ed1-b8cd-0af91f5a7d90\",\"callPart\":133,\"resultPart\":134,\"callTimestamp\":\"2026-10-10T00:30:07.402+00:00\",\"responseTimestamp\":\"2026-10-10T00:30:10.049+00:00\",\"mechanisms\":[\"native-wrapper\"],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "35022684",
      "nativeSession": "01a12329-777a-7b80-8fc3-ab01535f10ae",
      "exitCode": 0,
      "timeout": false,
      "elapsedMs": 557,
      "inputBytes": 19769,
      "stdout": "{\"rows\":[{\"request_id\":\"35022684\",\"owner\":\"su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a12329-777a-7b80-8fc3-ab01535f10ae\",\"callPart\":104,\"resultPart\":105,\"callTimestamp\":\"2026-10-10T00:33:31+00:00\",\"responseTimestamp\":\"2026-10-10T00:33:33.014+00:00\",\"mechanisms\":[\"native-wrapper\",\"invoke\"],\"conditionalAlternatives\":true,\"chain\":null,\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":false,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "35023582",
      "nativeSession": "01a1232c-37f8-7e61-a664-1dbf34681ab9",
      "exitCode": 0,
      "timeout": false,
      "elapsedMs": 490,
      "inputBytes": 31017,
      "stdout": "{\"rows\":[{\"request_id\":\"35023582\",\"owner\":\"su-960a52e7-9b11-42ac-8fe9-7e5e7e0da441\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a1232c-37f8-7e61-a664-1dbf34681ab9\",\"callPart\":108,\"resultPart\":109,\"callTimestamp\":\"2026-10-10T00:35:01.359+00:00\",\"responseTimestamp\":\"2026-10-10T00:35:12.91+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":false,\"parseErrors\":1,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "35031846",
      "nativeSession": "01a1233d-49f6-7fb3-b489-37d80ae709a0",
      "exitCode": 0,
      "timeout": false,
      "elapsedMs": 504,
      "inputBytes": 28475,
      "stdout": "{\"rows\":[{\"request_id\":\"35031846\",\"owner\":\"su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5\",\"completeOriginalPair\":true,\"pairs\":[{\"nativeSession\":\"01a1233d-49f6-7fb3-b489-37d80ae709a0\",\"callPart\":65,\"resultPart\":66,\"callTimestamp\":\"2026-10-10T00:50:16.169+00:00\",\"responseTimestamp\":\"2026-10-10T00:50:29.501+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":false,\"sourceComplete\":false,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false},{\"nativeSession\":\"01a1233d-49f6-7fb3-b489-37d80ae709a0\",\"callPart\":67,\"resultPart\":68,\"callTimestamp\":\"2026-10-10T00:50:33.52+00:00\",\"responseTimestamp\":\"2026-10-10T00:51:04.55+00:00\",\"mechanisms\":[\"ptool-invoke-quoted-json\"],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":false,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false},{\"nativeSession\":\"01a1233d-49f6-7fb3-b489-37d80ae709a0\",\"callPart\":67,\"resultPart\":70,\"callTimestamp\":\"2026-10-10T00:50:33.52+00:00\",\"responseTimestamp\":\"2026-10-10T00:51:10.514+00:00\",\"mechanisms\":[\"ptool-invoke-quoted-json\"],\"conditionalAlternatives\":false,\"chain\":{\"cellId\":\"27\",\"yieldPart\":68,\"waitPart\":69,\"originalCallPart\":67},\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"queued\",\"statusAgrees\":true,\"format\":\"json\",\"requested\":true,\"respawn\":\"queued\",\"completeOriginalPair\":true}],\"receiptState\":\"queued\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "35039357",
      "nativeSession": "01a12348-953f-7483-9589-e1a23948d6f5",
      "exitCode": 0,
      "timeout": false,
      "elapsedMs": 447,
      "inputBytes": 28135,
      "stdout": "{\"rows\":[{\"request_id\":\"35039357\",\"owner\":\"su-449b83a8-a709-43af-9681-768dc6ac744a\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a12348-953f-7483-9589-e1a23948d6f5\",\"callPart\":138,\"resultPart\":139,\"callTimestamp\":\"2026-10-10T01:05:26.418+00:00\",\"responseTimestamp\":\"2026-10-10T01:05:29.307+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":false,\"parseErrors\":1,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "35042969",
      "nativeSession": "01a12358-40b3-7071-afa8-73e105e0851b",
      "exitCode": 0,
      "timeout": false,
      "elapsedMs": 511,
      "inputBytes": 27912,
      "stdout": "{\"rows\":[{\"request_id\":\"35042969\",\"owner\":\"su-449b83a8-a709-43af-9681-768dc6ac744a\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a12358-40b3-7071-afa8-73e105e0851b\",\"callPart\":47,\"resultPart\":48,\"callTimestamp\":\"2026-10-10T01:11:02.234+00:00\",\"responseTimestamp\":\"2026-10-10T01:11:04.06+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":false,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    }
  ],
  "summary": {
    "targets": 22,
    "newComplete": 2,
    "unresolved": 20,
    "executions": 16,
    "timeouts": 0,
    "failedExecutions": 0,
    "outcomesJoined": 0
  },
  "limits": [
    "Prior78 complete records immutable; original137 denominator unchanged.",
    "Whole116 continuity/eligibility remain unaccepted; outcomesJoined0."
  ]
}
