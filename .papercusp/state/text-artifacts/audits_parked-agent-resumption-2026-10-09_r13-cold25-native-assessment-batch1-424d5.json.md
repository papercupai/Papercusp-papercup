---
rel_path: "audits/parked-agent-resumption-2026-10-09/r13-cold25-native-assessment-batch1-424d5.json"
updated_at: 1791895178074
_body: "content"
---

{
  "schemaVersion": "cold25-original-source-native-assessment-v1",
  "observedAt": "2026-10-13T12:39:36.311Z",
  "cohortHash": "24ff6981fd54f120f96381dd93732ec9c1bfb2101d7eec063119bf85caeb163a",
  "sourceRefs": [
    "audits/parked-agent-resumption-2026-10-09/r13-cold24-original137-custody-assessment-424d5.json",
    "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch1-424d5.json",
    "audits/parked-agent-resumption-2026-10-09/r13-cold25-native-analysis-instrument-424d5.json"
  ],
  "instrumentSha256": "cc0980905d0e8c57da7aef4e499baaec8f5538687eb30be1e27448cd55ea8b15",
  "method": "New validated literal aliases, conditional paths and labelled receipt analysis; exact source isolated by native session; deduplicate exact call/result pairs. All native process outcomes retained.",
  "rows": [
    {
      "request_id": "32216380",
      "owner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
      "acceptedUnique": true,
      "completeOriginalPair": true,
      "receiptState": "queued",
      "pairs": [
        {
          "nativeSession": "01a1112b-5115-7990-a36b-c354420236b0",
          "callPart": 107,
          "resultPart": 108,
          "callTimestamp": "2026-10-06T12:43:18.775+00:00",
          "responseTimestamp": "2026-10-06T12:43:26.168+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": false,
          "sourceComplete": false,
          "parseErrors": 1,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        },
        {
          "nativeSession": "01a1112b-5115-7990-a36b-c354420236b0",
          "callPart": 109,
          "resultPart": 110,
          "callTimestamp": "2026-10-06T12:43:34.417+00:00",
          "responseTimestamp": "2026-10-06T12:44:04.626+00:00",
          "mechanisms": [
            "invoke"
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
      "request_id": "32231391",
      "owner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a1113e-65dd-7822-9033-cde625ea52e3",
          "callPart": 70,
          "resultPart": 74,
          "callTimestamp": "2026-10-06T13:11:35.718+00:00",
          "responseTimestamp": "2026-10-06T13:12:35.635+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "30",
            "yieldPart": 71,
            "waitPart": 73,
            "originalCallPart": 70
          },
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": false,
          "parseErrors": 1,
          "receiptState": "queued",
          "statusAgrees": true,
          "format": "toon",
          "requested": true,
          "respawn": "queued",
          "completeOriginalPair": false
        }
      ],
      "acceptedPairCount": 0,
      "outcomeJoined": false
    },
    {
      "request_id": "32243511",
      "owner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a11158-b6c7-7c23-8712-bc632b5004fa",
          "callPart": 115,
          "resultPart": 116,
          "callTimestamp": "2026-10-06T13:34:56.224+00:00",
          "responseTimestamp": "2026-10-06T13:34:59.831+00:00",
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
      "request_id": "34831365",
      "owner": "su-ab8cc07f-e903-4467-ac45-a32149258170",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [],
      "acceptedPairCount": 0,
      "outcomeJoined": false
    },
    {
      "request_id": "34840615",
      "owner": "su-ab8cc07f-e903-4467-ac45-a32149258170",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a121f3-2211-7912-b4f6-78fd26b41ca4",
          "callPart": 120,
          "resultPart": 121,
          "callTimestamp": "2026-10-09T18:51:17.671+00:00",
          "responseTimestamp": "2026-10-09T18:51:17.735+00:00",
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
        },
        {
          "nativeSession": "01a121f3-2211-7912-b4f6-78fd26b41ca4",
          "callPart": 122,
          "resultPart": 123,
          "callTimestamp": "2026-10-09T18:51:34.793+00:00",
          "responseTimestamp": "2026-10-09T18:51:39.693+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": false,
          "parseErrors": 4,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        }
      ],
      "acceptedPairCount": 0,
      "outcomeJoined": false
    },
    {
      "request_id": "34863926",
      "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a12212-c9fe-7921-bc00-6644cf505bab",
          "callPart": 121,
          "resultPart": 122,
          "callTimestamp": "2026-10-09T19:33:42.959+00:00",
          "responseTimestamp": "2026-10-09T19:33:44.975+00:00",
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
      "request_id": "34866872",
      "owner": "su-ab8cc07f-e903-4467-ac45-a32149258170",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a12215-f913-74d0-8930-463399a84938",
          "callPart": 129,
          "resultPart": 132,
          "callTimestamp": "2026-10-09T19:38:29.111+00:00",
          "responseTimestamp": "2026-10-09T19:39:03.545+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "58",
            "yieldPart": 130,
            "waitPart": 131,
            "originalCallPart": 129
          },
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": false,
          "parseErrors": 1,
          "receiptState": "queued",
          "statusAgrees": true,
          "format": "toon",
          "requested": true,
          "respawn": "queued",
          "completeOriginalPair": false
        }
      ],
      "acceptedPairCount": 0,
      "outcomeJoined": false
    },
    {
      "request_id": "34886663",
      "owner": "su-82c46308-5eb9-4237-9d2d-950d322576c4",
      "acceptedUnique": true,
      "completeOriginalPair": true,
      "receiptState": "queued",
      "pairs": [
        {
          "nativeSession": "01a1222f-4f0d-71b2-b283-fb4c74b79830",
          "callPart": 165,
          "resultPart": 166,
          "callTimestamp": "2026-10-09T20:17:24.991+00:00",
          "responseTimestamp": "2026-10-09T20:17:52.084+00:00",
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
          "nativeSession": "01a1222f-4f0d-71b2-b283-fb4c74b79830",
          "callPart": 167,
          "resultPart": 168,
          "callTimestamp": "2026-10-09T20:18:08.976+00:00",
          "responseTimestamp": "2026-10-09T20:18:40.031+00:00",
          "mechanisms": [
            "invoke"
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
        },
        {
          "nativeSession": "01a1222f-4f0d-71b2-b283-fb4c74b79830",
          "callPart": 167,
          "resultPart": 170,
          "callTimestamp": "2026-10-09T20:18:08.976+00:00",
          "responseTimestamp": "2026-10-09T20:18:43.48+00:00",
          "mechanisms": [
            "invoke"
          ],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "62",
            "yieldPart": 168,
            "waitPart": 169,
            "originalCallPart": 167
          },
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
      "request_id": "34887447",
      "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a1223d-8d3b-73d2-ba27-19a009e9bfc7",
          "callPart": 125,
          "resultPart": 126,
          "callTimestamp": "2026-10-09T20:19:55.221+00:00",
          "responseTimestamp": "2026-10-09T20:19:57.857+00:00",
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
      "request_id": "34888135",
      "owner": "su-ab8cc07f-e903-4467-ac45-a32149258170",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [],
      "acceptedPairCount": 0,
      "outcomeJoined": false
    },
    {
      "request_id": "34897845",
      "owner": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
      "acceptedUnique": true,
      "completeOriginalPair": true,
      "receiptState": "queued",
      "pairs": [
        {
          "nativeSession": "01a1224b-a4da-7813-8679-5959b1e641f6",
          "callPart": 137,
          "resultPart": 138,
          "callTimestamp": "2026-10-09T20:33:51.409+00:00",
          "responseTimestamp": "2026-10-09T20:34:20.249+00:00",
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
        },
        {
          "nativeSession": "01a1224b-a4da-7813-8679-5959b1e641f6",
          "callPart": 139,
          "resultPart": 140,
          "callTimestamp": "2026-10-09T20:34:27.166+00:00",
          "responseTimestamp": "2026-10-09T20:34:58.203+00:00",
          "mechanisms": [
            "native-wrapper"
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
          "nativeSession": "01a1224b-a4da-7813-8679-5959b1e641f6",
          "callPart": 139,
          "resultPart": 142,
          "callTimestamp": "2026-10-09T20:34:27.166+00:00",
          "responseTimestamp": "2026-10-09T20:35:19.153+00:00",
          "mechanisms": [
            "native-wrapper"
          ],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "63",
            "yieldPart": 140,
            "waitPart": 141,
            "originalCallPart": 139
          },
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
      "request_id": "34911877",
      "owner": "su-ab8cc07f-e903-4467-ac45-a32149258170",
      "acceptedUnique": true,
      "completeOriginalPair": true,
      "receiptState": "queued",
      "pairs": [
        {
          "nativeSession": "01a12263-9cc1-78b0-bc03-6f19c79a2fb0",
          "callPart": 83,
          "resultPart": 86,
          "callTimestamp": "2026-10-09T21:00:27.287+00:00",
          "responseTimestamp": "2026-10-09T21:01:03.633+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "32",
            "yieldPart": 84,
            "waitPart": 85,
            "originalCallPart": 83
          },
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": false,
          "sourceComplete": true,
          "parseErrors": 0,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        },
        {
          "nativeSession": "01a12263-9cc1-78b0-bc03-6f19c79a2fb0",
          "callPart": 87,
          "resultPart": 88,
          "callTimestamp": "2026-10-09T21:01:10.291+00:00",
          "responseTimestamp": "2026-10-09T21:01:29.144+00:00",
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
      "request_id": "34912704",
      "owner": "su-ba80f2f7-46f6-4aec-b99a-21e02460933f",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a12266-3e63-7283-821f-8cbcd5c543fa",
          "callPart": 134,
          "resultPart": 135,
          "callTimestamp": "2026-10-09T21:01:38.777+00:00",
          "responseTimestamp": "2026-10-09T21:01:38.839+00:00",
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
        },
        {
          "nativeSession": "01a12266-3e63-7283-821f-8cbcd5c543fa",
          "callPart": 138,
          "resultPart": 139,
          "callTimestamp": "2026-10-09T21:02:07.475+00:00",
          "responseTimestamp": "2026-10-09T21:02:39.911+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": false,
          "sourceComplete": false,
          "parseErrors": 1,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        },
        {
          "nativeSession": "01a12266-3e63-7283-821f-8cbcd5c543fa",
          "callPart": 138,
          "resultPart": 141,
          "callTimestamp": "2026-10-09T21:02:07.475+00:00",
          "responseTimestamp": "2026-10-09T21:02:53.226+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "55",
            "yieldPart": 139,
            "waitPart": 140,
            "originalCallPart": 138
          },
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": false,
          "parseErrors": 1,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        },
        {
          "nativeSession": "01a12266-3e63-7283-821f-8cbcd5c543fa",
          "callPart": 140,
          "resultPart": 143,
          "callTimestamp": "2026-10-09T21:02:42.218+00:00",
          "responseTimestamp": "2026-10-09T21:02:56.38+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "55",
            "yieldPart": 141,
            "waitPart": 142,
            "originalCallPart": 140
          },
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": false,
          "sourceComplete": true,
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
      "request_id": "34937571",
      "owner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
      "acceptedUnique": true,
      "completeOriginalPair": true,
      "receiptState": "queued",
      "pairs": [
        {
          "nativeSession": "01a1228f-1738-79e1-8225-adb923521fa8",
          "callPart": 89,
          "resultPart": 90,
          "callTimestamp": "2026-10-09T21:45:05.932+00:00",
          "responseTimestamp": "2026-10-09T21:45:12.504+00:00",
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
          "nativeSession": "01a1228f-1738-79e1-8225-adb923521fa8",
          "callPart": 91,
          "resultPart": 92,
          "callTimestamp": "2026-10-09T21:45:17.434+00:00",
          "responseTimestamp": "2026-10-09T21:45:48.475+00:00",
          "mechanisms": [
            "native-wrapper",
            "invoke"
          ],
          "conditionalAlternatives": true,
          "chain": null,
          "literalArgsEqual": true,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": true,
          "parseErrors": 0,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        },
        {
          "nativeSession": "01a1228f-1738-79e1-8225-adb923521fa8",
          "callPart": 91,
          "resultPart": 94,
          "callTimestamp": "2026-10-09T21:45:17.434+00:00",
          "responseTimestamp": "2026-10-09T21:45:51.529+00:00",
          "mechanisms": [
            "native-wrapper",
            "invoke"
          ],
          "conditionalAlternatives": true,
          "chain": {
            "cellId": "39",
            "yieldPart": 92,
            "waitPart": 93,
            "originalCallPart": 91
          },
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
      "request_id": "34938104",
      "owner": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a1228c-7bc5-76c2-ac09-038120bb49b5",
          "callPart": 120,
          "resultPart": 121,
          "callTimestamp": "2026-10-09T21:46:14.411+00:00",
          "responseTimestamp": "2026-10-09T21:46:45.459+00:00",
          "mechanisms": [
            "ptool-quoted-json"
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
        },
        {
          "nativeSession": "01a1228c-7bc5-76c2-ac09-038120bb49b5",
          "callPart": 120,
          "resultPart": 123,
          "callTimestamp": "2026-10-09T21:46:14.411+00:00",
          "responseTimestamp": "2026-10-09T21:46:50.775+00:00",
          "mechanisms": [
            "ptool-quoted-json"
          ],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "51",
            "yieldPart": 121,
            "waitPart": 122,
            "originalCallPart": 120
          },
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
      "request_id": "34952665",
      "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
      "acceptedUnique": true,
      "completeOriginalPair": true,
      "receiptState": "queued",
      "pairs": [
        {
          "nativeSession": "01a122a7-e41a-7f92-9cfc-a825eca90ad8",
          "callPart": 109,
          "resultPart": 110,
          "callTimestamp": "2026-10-09T22:12:40.227+00:00",
          "responseTimestamp": "2026-10-09T22:12:41.672+00:00",
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
      "request_id": "34967591",
      "owner": "su-82c46308-5eb9-4237-9d2d-950d322576c4",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a122c4-d22d-72b3-8c37-5ef6c96c94bb",
          "callPart": 80,
          "resultPart": 81,
          "callTimestamp": "2026-10-09T22:44:14.079+00:00",
          "responseTimestamp": "2026-10-09T22:44:17.1+00:00",
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
    }
  ],
  "sessionAssessments": [
    {
      "request_id": "32216380",
      "owner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
      "completeOriginalPair": true,
      "pairs": [
        {
          "nativeSession": "01a1112b-5115-7990-a36b-c354420236b0",
          "callPart": 107,
          "resultPart": 108,
          "callTimestamp": "2026-10-06T12:43:18.775+00:00",
          "responseTimestamp": "2026-10-06T12:43:26.168+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": false,
          "sourceComplete": false,
          "parseErrors": 1,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        },
        {
          "nativeSession": "01a1112b-5115-7990-a36b-c354420236b0",
          "callPart": 109,
          "resultPart": 110,
          "callTimestamp": "2026-10-06T12:43:34.417+00:00",
          "responseTimestamp": "2026-10-06T12:44:04.626+00:00",
          "mechanisms": [
            "invoke"
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
      "request_id": "32231391",
      "owner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a1113e-65dd-7822-9033-cde625ea52e3",
          "callPart": 70,
          "resultPart": 74,
          "callTimestamp": "2026-10-06T13:11:35.718+00:00",
          "responseTimestamp": "2026-10-06T13:12:35.635+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "30",
            "yieldPart": 71,
            "waitPart": 73,
            "originalCallPart": 70
          },
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": false,
          "parseErrors": 1,
          "receiptState": "queued",
          "statusAgrees": true,
          "format": "toon",
          "requested": true,
          "respawn": "queued",
          "completeOriginalPair": false
        }
      ],
      "receiptState": "unresolved",
      "outcomeJoined": false
    },
    {
      "request_id": "32243511",
      "owner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a11158-b6c7-7c23-8712-bc632b5004fa",
          "callPart": 115,
          "resultPart": 116,
          "callTimestamp": "2026-10-06T13:34:56.224+00:00",
          "responseTimestamp": "2026-10-06T13:34:59.831+00:00",
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
      "request_id": "34840615",
      "owner": "su-ab8cc07f-e903-4467-ac45-a32149258170",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a121f3-2211-7912-b4f6-78fd26b41ca4",
          "callPart": 120,
          "resultPart": 121,
          "callTimestamp": "2026-10-09T18:51:17.671+00:00",
          "responseTimestamp": "2026-10-09T18:51:17.735+00:00",
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
        },
        {
          "nativeSession": "01a121f3-2211-7912-b4f6-78fd26b41ca4",
          "callPart": 122,
          "resultPart": 123,
          "callTimestamp": "2026-10-09T18:51:34.793+00:00",
          "responseTimestamp": "2026-10-09T18:51:39.693+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": false,
          "parseErrors": 4,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        }
      ],
      "receiptState": "unresolved",
      "outcomeJoined": false
    },
    {
      "request_id": "34863926",
      "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a12212-c9fe-7921-bc00-6644cf505bab",
          "callPart": 121,
          "resultPart": 122,
          "callTimestamp": "2026-10-09T19:33:42.959+00:00",
          "responseTimestamp": "2026-10-09T19:33:44.975+00:00",
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
      "request_id": "34866872",
      "owner": "su-ab8cc07f-e903-4467-ac45-a32149258170",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a12215-f913-74d0-8930-463399a84938",
          "callPart": 129,
          "resultPart": 132,
          "callTimestamp": "2026-10-09T19:38:29.111+00:00",
          "responseTimestamp": "2026-10-09T19:39:03.545+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "58",
            "yieldPart": 130,
            "waitPart": 131,
            "originalCallPart": 129
          },
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": false,
          "parseErrors": 1,
          "receiptState": "queued",
          "statusAgrees": true,
          "format": "toon",
          "requested": true,
          "respawn": "queued",
          "completeOriginalPair": false
        }
      ],
      "receiptState": "unresolved",
      "outcomeJoined": false
    },
    {
      "request_id": "34886663",
      "owner": "su-82c46308-5eb9-4237-9d2d-950d322576c4",
      "completeOriginalPair": true,
      "pairs": [
        {
          "nativeSession": "01a1222f-4f0d-71b2-b283-fb4c74b79830",
          "callPart": 165,
          "resultPart": 166,
          "callTimestamp": "2026-10-09T20:17:24.991+00:00",
          "responseTimestamp": "2026-10-09T20:17:52.084+00:00",
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
          "nativeSession": "01a1222f-4f0d-71b2-b283-fb4c74b79830",
          "callPart": 167,
          "resultPart": 168,
          "callTimestamp": "2026-10-09T20:18:08.976+00:00",
          "responseTimestamp": "2026-10-09T20:18:40.031+00:00",
          "mechanisms": [
            "invoke"
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
        },
        {
          "nativeSession": "01a1222f-4f0d-71b2-b283-fb4c74b79830",
          "callPart": 167,
          "resultPart": 170,
          "callTimestamp": "2026-10-09T20:18:08.976+00:00",
          "responseTimestamp": "2026-10-09T20:18:43.48+00:00",
          "mechanisms": [
            "invoke"
          ],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "62",
            "yieldPart": 168,
            "waitPart": 169,
            "originalCallPart": 167
          },
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
      "request_id": "34887447",
      "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a1223d-8d3b-73d2-ba27-19a009e9bfc7",
          "callPart": 125,
          "resultPart": 126,
          "callTimestamp": "2026-10-09T20:19:55.221+00:00",
          "responseTimestamp": "2026-10-09T20:19:57.857+00:00",
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
      "request_id": "34897845",
      "owner": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
      "completeOriginalPair": true,
      "pairs": [
        {
          "nativeSession": "01a1224b-a4da-7813-8679-5959b1e641f6",
          "callPart": 137,
          "resultPart": 138,
          "callTimestamp": "2026-10-09T20:33:51.409+00:00",
          "responseTimestamp": "2026-10-09T20:34:20.249+00:00",
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
        },
        {
          "nativeSession": "01a1224b-a4da-7813-8679-5959b1e641f6",
          "callPart": 139,
          "resultPart": 140,
          "callTimestamp": "2026-10-09T20:34:27.166+00:00",
          "responseTimestamp": "2026-10-09T20:34:58.203+00:00",
          "mechanisms": [
            "native-wrapper"
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
          "nativeSession": "01a1224b-a4da-7813-8679-5959b1e641f6",
          "callPart": 139,
          "resultPart": 142,
          "callTimestamp": "2026-10-09T20:34:27.166+00:00",
          "responseTimestamp": "2026-10-09T20:35:19.153+00:00",
          "mechanisms": [
            "native-wrapper"
          ],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "63",
            "yieldPart": 140,
            "waitPart": 141,
            "originalCallPart": 139
          },
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
      "request_id": "34911877",
      "owner": "su-ab8cc07f-e903-4467-ac45-a32149258170",
      "completeOriginalPair": true,
      "pairs": [
        {
          "nativeSession": "01a12263-9cc1-78b0-bc03-6f19c79a2fb0",
          "callPart": 83,
          "resultPart": 86,
          "callTimestamp": "2026-10-09T21:00:27.287+00:00",
          "responseTimestamp": "2026-10-09T21:01:03.633+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "32",
            "yieldPart": 84,
            "waitPart": 85,
            "originalCallPart": 83
          },
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": false,
          "sourceComplete": true,
          "parseErrors": 0,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        },
        {
          "nativeSession": "01a12263-9cc1-78b0-bc03-6f19c79a2fb0",
          "callPart": 87,
          "resultPart": 88,
          "callTimestamp": "2026-10-09T21:01:10.291+00:00",
          "responseTimestamp": "2026-10-09T21:01:29.144+00:00",
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
      "request_id": "34912704",
      "owner": "su-ba80f2f7-46f6-4aec-b99a-21e02460933f",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a12266-3e63-7283-821f-8cbcd5c543fa",
          "callPart": 134,
          "resultPart": 135,
          "callTimestamp": "2026-10-09T21:01:38.777+00:00",
          "responseTimestamp": "2026-10-09T21:01:38.839+00:00",
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
        },
        {
          "nativeSession": "01a12266-3e63-7283-821f-8cbcd5c543fa",
          "callPart": 138,
          "resultPart": 139,
          "callTimestamp": "2026-10-09T21:02:07.475+00:00",
          "responseTimestamp": "2026-10-09T21:02:39.911+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": false,
          "sourceComplete": false,
          "parseErrors": 1,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        },
        {
          "nativeSession": "01a12266-3e63-7283-821f-8cbcd5c543fa",
          "callPart": 138,
          "resultPart": 141,
          "callTimestamp": "2026-10-09T21:02:07.475+00:00",
          "responseTimestamp": "2026-10-09T21:02:53.226+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "55",
            "yieldPart": 139,
            "waitPart": 140,
            "originalCallPart": 138
          },
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": false,
          "parseErrors": 1,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        },
        {
          "nativeSession": "01a12266-3e63-7283-821f-8cbcd5c543fa",
          "callPart": 140,
          "resultPart": 143,
          "callTimestamp": "2026-10-09T21:02:42.218+00:00",
          "responseTimestamp": "2026-10-09T21:02:56.38+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "55",
            "yieldPart": 141,
            "waitPart": 142,
            "originalCallPart": 140
          },
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": false,
          "sourceComplete": true,
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
      "request_id": "34937571",
      "owner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
      "completeOriginalPair": true,
      "pairs": [
        {
          "nativeSession": "01a1228f-1738-79e1-8225-adb923521fa8",
          "callPart": 89,
          "resultPart": 90,
          "callTimestamp": "2026-10-09T21:45:05.932+00:00",
          "responseTimestamp": "2026-10-09T21:45:12.504+00:00",
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
          "nativeSession": "01a1228f-1738-79e1-8225-adb923521fa8",
          "callPart": 91,
          "resultPart": 92,
          "callTimestamp": "2026-10-09T21:45:17.434+00:00",
          "responseTimestamp": "2026-10-09T21:45:48.475+00:00",
          "mechanisms": [
            "native-wrapper",
            "invoke"
          ],
          "conditionalAlternatives": true,
          "chain": null,
          "literalArgsEqual": true,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": true,
          "parseErrors": 0,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        },
        {
          "nativeSession": "01a1228f-1738-79e1-8225-adb923521fa8",
          "callPart": 91,
          "resultPart": 94,
          "callTimestamp": "2026-10-09T21:45:17.434+00:00",
          "responseTimestamp": "2026-10-09T21:45:51.529+00:00",
          "mechanisms": [
            "native-wrapper",
            "invoke"
          ],
          "conditionalAlternatives": true,
          "chain": {
            "cellId": "39",
            "yieldPart": 92,
            "waitPart": 93,
            "originalCallPart": 91
          },
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
      "request_id": "34938104",
      "owner": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a1228c-7bc5-76c2-ac09-038120bb49b5",
          "callPart": 120,
          "resultPart": 121,
          "callTimestamp": "2026-10-09T21:46:14.411+00:00",
          "responseTimestamp": "2026-10-09T21:46:45.459+00:00",
          "mechanisms": [
            "ptool-quoted-json"
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
        },
        {
          "nativeSession": "01a1228c-7bc5-76c2-ac09-038120bb49b5",
          "callPart": 120,
          "resultPart": 123,
          "callTimestamp": "2026-10-09T21:46:14.411+00:00",
          "responseTimestamp": "2026-10-09T21:46:50.775+00:00",
          "mechanisms": [
            "ptool-quoted-json"
          ],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "51",
            "yieldPart": 121,
            "waitPart": 122,
            "originalCallPart": 120
          },
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
      "request_id": "34952665",
      "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
      "completeOriginalPair": true,
      "pairs": [
        {
          "nativeSession": "01a122a7-e41a-7f92-9cfc-a825eca90ad8",
          "callPart": 109,
          "resultPart": 110,
          "callTimestamp": "2026-10-09T22:12:40.227+00:00",
          "responseTimestamp": "2026-10-09T22:12:41.672+00:00",
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
      "request_id": "34967591",
      "owner": "su-82c46308-5eb9-4237-9d2d-950d322576c4",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a122c4-d22d-72b3-8c37-5ef6c96c94bb",
          "callPart": 80,
          "resultPart": 81,
          "callTimestamp": "2026-10-09T22:44:14.079+00:00",
          "responseTimestamp": "2026-10-09T22:44:17.1+00:00",
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
    }
  ],
  "executions": [
    {
      "request_id": "32216380",
      "nativeSession": "01a1112b-5115-7990-a36b-c354420236b0",
      "exitCode": 0,
      "timeout": false,
      "elapsedMs": 1653,
      "inputBytes": 35247,
      "stdout": "{\"rows\":[{\"request_id\":\"32216380\",\"owner\":\"su-f0e98560-52c5-4afe-8709-46fef49a576e\",\"completeOriginalPair\":true,\"pairs\":[{\"nativeSession\":\"01a1112b-5115-7990-a36b-c354420236b0\",\"callPart\":107,\"resultPart\":108,\"callTimestamp\":\"2026-10-06T12:43:18.775+00:00\",\"responseTimestamp\":\"2026-10-06T12:43:26.168+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":false,\"sourceComplete\":false,\"parseErrors\":1,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false},{\"nativeSession\":\"01a1112b-5115-7990-a36b-c354420236b0\",\"callPart\":109,\"resultPart\":110,\"callTimestamp\":\"2026-10-06T12:43:34.417+00:00\",\"responseTimestamp\":\"2026-10-06T12:44:04.626+00:00\",\"mechanisms\":[\"invoke\"],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"queued\",\"statusAgrees\":true,\"format\":\"toon\",\"requested\":true,\"respawn\":\"queued\",\"completeOriginalPair\":true}],\"receiptState\":\"queued\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "32231391",
      "nativeSession": "01a1113e-65dd-7822-9033-cde625ea52e3",
      "exitCode": 0,
      "timeout": false,
      "elapsedMs": 509,
      "inputBytes": 16018,
      "stdout": "{\"rows\":[{\"request_id\":\"32231391\",\"owner\":\"su-f0e98560-52c5-4afe-8709-46fef49a576e\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a1113e-65dd-7822-9033-cde625ea52e3\",\"callPart\":70,\"resultPart\":74,\"callTimestamp\":\"2026-10-06T13:11:35.718+00:00\",\"responseTimestamp\":\"2026-10-06T13:12:35.635+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":{\"cellId\":\"30\",\"yieldPart\":71,\"waitPart\":73,\"originalCallPart\":70},\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":false,\"parseErrors\":1,\"receiptState\":\"queued\",\"statusAgrees\":true,\"format\":\"toon\",\"requested\":true,\"respawn\":\"queued\",\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "32243511",
      "nativeSession": "01a11158-b6c7-7c23-8712-bc632b5004fa",
      "exitCode": 0,
      "timeout": false,
      "elapsedMs": 467,
      "inputBytes": 13224,
      "stdout": "{\"rows\":[{\"request_id\":\"32243511\",\"owner\":\"su-f0e98560-52c5-4afe-8709-46fef49a576e\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a11158-b6c7-7c23-8712-bc632b5004fa\",\"callPart\":115,\"resultPart\":116,\"callTimestamp\":\"2026-10-06T13:34:56.224+00:00\",\"responseTimestamp\":\"2026-10-06T13:34:59.831+00:00\",\"mechanisms\":[\"native-wrapper\"],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":false,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "34840615",
      "nativeSession": "01a121f3-2211-7912-b4f6-78fd26b41ca4",
      "exitCode": 0,
      "timeout": false,
      "elapsedMs": 416,
      "inputBytes": 42178,
      "stdout": "{\"rows\":[{\"request_id\":\"34840615\",\"owner\":\"su-ab8cc07f-e903-4467-ac45-a32149258170\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a121f3-2211-7912-b4f6-78fd26b41ca4\",\"callPart\":120,\"resultPart\":121,\"callTimestamp\":\"2026-10-09T18:51:17.671+00:00\",\"responseTimestamp\":\"2026-10-09T18:51:17.735+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":false,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false},{\"nativeSession\":\"01a121f3-2211-7912-b4f6-78fd26b41ca4\",\"callPart\":122,\"resultPart\":123,\"callTimestamp\":\"2026-10-09T18:51:34.793+00:00\",\"responseTimestamp\":\"2026-10-09T18:51:39.693+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":false,\"parseErrors\":4,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "34863926",
      "nativeSession": "01a12212-c9fe-7921-bc00-6644cf505bab",
      "exitCode": 0,
      "timeout": false,
      "elapsedMs": 579,
      "inputBytes": 33543,
      "stdout": "{\"rows\":[{\"request_id\":\"34863926\",\"owner\":\"su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a12212-c9fe-7921-bc00-6644cf505bab\",\"callPart\":121,\"resultPart\":122,\"callTimestamp\":\"2026-10-09T19:33:42.959+00:00\",\"responseTimestamp\":\"2026-10-09T19:33:44.975+00:00\",\"mechanisms\":[\"native-wrapper\"],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":false,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "34866872",
      "nativeSession": "01a12215-f913-74d0-8930-463399a84938",
      "exitCode": 0,
      "timeout": false,
      "elapsedMs": 452,
      "inputBytes": 19660,
      "stdout": "{\"rows\":[{\"request_id\":\"34866872\",\"owner\":\"su-ab8cc07f-e903-4467-ac45-a32149258170\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a12215-f913-74d0-8930-463399a84938\",\"callPart\":129,\"resultPart\":132,\"callTimestamp\":\"2026-10-09T19:38:29.111+00:00\",\"responseTimestamp\":\"2026-10-09T19:39:03.545+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":{\"cellId\":\"58\",\"yieldPart\":130,\"waitPart\":131,\"originalCallPart\":129},\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":false,\"parseErrors\":1,\"receiptState\":\"queued\",\"statusAgrees\":true,\"format\":\"toon\",\"requested\":true,\"respawn\":\"queued\",\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "34886663",
      "nativeSession": "01a1222f-4f0d-71b2-b283-fb4c74b79830",
      "exitCode": 0,
      "timeout": false,
      "elapsedMs": 751,
      "inputBytes": 25598,
      "stdout": "{\"rows\":[{\"request_id\":\"34886663\",\"owner\":\"su-82c46308-5eb9-4237-9d2d-950d322576c4\",\"completeOriginalPair\":true,\"pairs\":[{\"nativeSession\":\"01a1222f-4f0d-71b2-b283-fb4c74b79830\",\"callPart\":165,\"resultPart\":166,\"callTimestamp\":\"2026-10-09T20:17:24.991+00:00\",\"responseTimestamp\":\"2026-10-09T20:17:52.084+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":false,\"sourceComplete\":false,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false},{\"nativeSession\":\"01a1222f-4f0d-71b2-b283-fb4c74b79830\",\"callPart\":167,\"resultPart\":168,\"callTimestamp\":\"2026-10-09T20:18:08.976+00:00\",\"responseTimestamp\":\"2026-10-09T20:18:40.031+00:00\",\"mechanisms\":[\"invoke\"],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false},{\"nativeSession\":\"01a1222f-4f0d-71b2-b283-fb4c74b79830\",\"callPart\":167,\"resultPart\":170,\"callTimestamp\":\"2026-10-09T20:18:08.976+00:00\",\"responseTimestamp\":\"2026-10-09T20:18:43.48+00:00\",\"mechanisms\":[\"invoke\"],\"conditionalAlternatives\":false,\"chain\":{\"cellId\":\"62\",\"yieldPart\":168,\"waitPart\":169,\"originalCallPart\":167},\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"queued\",\"statusAgrees\":true,\"format\":\"toon\",\"requested\":true,\"respawn\":\"queued\",\"completeOriginalPair\":true}],\"receiptState\":\"queued\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "34887447",
      "nativeSession": "01a1223d-8d3b-73d2-ba27-19a009e9bfc7",
      "exitCode": 0,
      "timeout": false,
      "elapsedMs": 362,
      "inputBytes": 28087,
      "stdout": "{\"rows\":[{\"request_id\":\"34887447\",\"owner\":\"su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a1223d-8d3b-73d2-ba27-19a009e9bfc7\",\"callPart\":125,\"resultPart\":126,\"callTimestamp\":\"2026-10-09T20:19:55.221+00:00\",\"responseTimestamp\":\"2026-10-09T20:19:57.857+00:00\",\"mechanisms\":[\"native-wrapper\"],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":false,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "34897845",
      "nativeSession": "01a1224b-a4da-7813-8679-5959b1e641f6",
      "exitCode": 0,
      "timeout": false,
      "elapsedMs": 468,
      "inputBytes": 27890,
      "stdout": "{\"rows\":[{\"request_id\":\"34897845\",\"owner\":\"su-77348e3d-80ac-42d8-b4e7-bdce9684a72a\",\"completeOriginalPair\":true,\"pairs\":[{\"nativeSession\":\"01a1224b-a4da-7813-8679-5959b1e641f6\",\"callPart\":137,\"resultPart\":138,\"callTimestamp\":\"2026-10-09T20:33:51.409+00:00\",\"responseTimestamp\":\"2026-10-09T20:34:20.249+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":false,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false},{\"nativeSession\":\"01a1224b-a4da-7813-8679-5959b1e641f6\",\"callPart\":139,\"resultPart\":140,\"callTimestamp\":\"2026-10-09T20:34:27.166+00:00\",\"responseTimestamp\":\"2026-10-09T20:34:58.203+00:00\",\"mechanisms\":[\"native-wrapper\"],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":false,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false},{\"nativeSession\":\"01a1224b-a4da-7813-8679-5959b1e641f6\",\"callPart\":139,\"resultPart\":142,\"callTimestamp\":\"2026-10-09T20:34:27.166+00:00\",\"responseTimestamp\":\"2026-10-09T20:35:19.153+00:00\",\"mechanisms\":[\"native-wrapper\"],\"conditionalAlternatives\":false,\"chain\":{\"cellId\":\"63\",\"yieldPart\":140,\"waitPart\":141,\"originalCallPart\":139},\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"queued\",\"statusAgrees\":true,\"format\":\"toon\",\"requested\":true,\"respawn\":\"queued\",\"completeOriginalPair\":true}],\"receiptState\":\"queued\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "34911877",
      "nativeSession": "01a12263-9cc1-78b0-bc03-6f19c79a2fb0",
      "exitCode": 0,
      "timeout": false,
      "elapsedMs": 310,
      "inputBytes": 14842,
      "stdout": "{\"rows\":[{\"request_id\":\"34911877\",\"owner\":\"su-ab8cc07f-e903-4467-ac45-a32149258170\",\"completeOriginalPair\":true,\"pairs\":[{\"nativeSession\":\"01a12263-9cc1-78b0-bc03-6f19c79a2fb0\",\"callPart\":83,\"resultPart\":86,\"callTimestamp\":\"2026-10-09T21:00:27.287+00:00\",\"responseTimestamp\":\"2026-10-09T21:01:03.633+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":{\"cellId\":\"32\",\"yieldPart\":84,\"waitPart\":85,\"originalCallPart\":83},\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":false,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false},{\"nativeSession\":\"01a12263-9cc1-78b0-bc03-6f19c79a2fb0\",\"callPart\":87,\"resultPart\":88,\"callTimestamp\":\"2026-10-09T21:01:10.291+00:00\",\"responseTimestamp\":\"2026-10-09T21:01:29.144+00:00\",\"mechanisms\":[\"native-wrapper\"],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"queued\",\"statusAgrees\":true,\"format\":\"toon\",\"requested\":true,\"respawn\":\"queued\",\"completeOriginalPair\":true}],\"receiptState\":\"queued\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "34912704",
      "nativeSession": "01a12266-3e63-7283-821f-8cbcd5c543fa",
      "exitCode": 0,
      "timeout": false,
      "elapsedMs": 326,
      "inputBytes": 30719,
      "stdout": "{\"rows\":[{\"request_id\":\"34912704\",\"owner\":\"su-ba80f2f7-46f6-4aec-b99a-21e02460933f\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a12266-3e63-7283-821f-8cbcd5c543fa\",\"callPart\":134,\"resultPart\":135,\"callTimestamp\":\"2026-10-09T21:01:38.777+00:00\",\"responseTimestamp\":\"2026-10-09T21:01:38.839+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":false,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false},{\"nativeSession\":\"01a12266-3e63-7283-821f-8cbcd5c543fa\",\"callPart\":138,\"resultPart\":139,\"callTimestamp\":\"2026-10-09T21:02:07.475+00:00\",\"responseTimestamp\":\"2026-10-09T21:02:39.911+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":false,\"sourceComplete\":false,\"parseErrors\":1,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false},{\"nativeSession\":\"01a12266-3e63-7283-821f-8cbcd5c543fa\",\"callPart\":138,\"resultPart\":141,\"callTimestamp\":\"2026-10-09T21:02:07.475+00:00\",\"responseTimestamp\":\"2026-10-09T21:02:53.226+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":{\"cellId\":\"55\",\"yieldPart\":139,\"waitPart\":140,\"originalCallPart\":138},\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":false,\"parseErrors\":1,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false},{\"nativeSession\":\"01a12266-3e63-7283-821f-8cbcd5c543fa\",\"callPart\":140,\"resultPart\":143,\"callTimestamp\":\"2026-10-09T21:02:42.218+00:00\",\"responseTimestamp\":\"2026-10-09T21:02:56.38+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":{\"cellId\":\"55\",\"yieldPart\":141,\"waitPart\":142,\"originalCallPart\":140},\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":false,\"sourceComplete\":true,\"parseErrors\":3,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "34937571",
      "nativeSession": "01a1228f-1738-79e1-8225-adb923521fa8",
      "exitCode": 0,
      "timeout": false,
      "elapsedMs": 302,
      "inputBytes": 27080,
      "stdout": "{\"rows\":[{\"request_id\":\"34937571\",\"owner\":\"su-f0e98560-52c5-4afe-8709-46fef49a576e\",\"completeOriginalPair\":true,\"pairs\":[{\"nativeSession\":\"01a1228f-1738-79e1-8225-adb923521fa8\",\"callPart\":89,\"resultPart\":90,\"callTimestamp\":\"2026-10-09T21:45:05.932+00:00\",\"responseTimestamp\":\"2026-10-09T21:45:12.504+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":false,\"sourceComplete\":false,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false},{\"nativeSession\":\"01a1228f-1738-79e1-8225-adb923521fa8\",\"callPart\":91,\"resultPart\":92,\"callTimestamp\":\"2026-10-09T21:45:17.434+00:00\",\"responseTimestamp\":\"2026-10-09T21:45:48.475+00:00\",\"mechanisms\":[\"native-wrapper\",\"invoke\"],\"conditionalAlternatives\":true,\"chain\":null,\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false},{\"nativeSession\":\"01a1228f-1738-79e1-8225-adb923521fa8\",\"callPart\":91,\"resultPart\":94,\"callTimestamp\":\"2026-10-09T21:45:17.434+00:00\",\"responseTimestamp\":\"2026-10-09T21:45:51.529+00:00\",\"mechanisms\":[\"native-wrapper\",\"invoke\"],\"conditionalAlternatives\":true,\"chain\":{\"cellId\":\"39\",\"yieldPart\":92,\"waitPart\":93,\"originalCallPart\":91},\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"queued\",\"statusAgrees\":true,\"format\":\"toon\",\"requested\":true,\"respawn\":\"queued\",\"completeOriginalPair\":true}],\"receiptState\":\"queued\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "34938104",
      "nativeSession": "01a1228c-7bc5-76c2-ac09-038120bb49b5",
      "exitCode": 0,
      "timeout": false,
      "elapsedMs": 324,
      "inputBytes": 36529,
      "stdout": "{\"rows\":[{\"request_id\":\"34938104\",\"owner\":\"su-77348e3d-80ac-42d8-b4e7-bdce9684a72a\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a1228c-7bc5-76c2-ac09-038120bb49b5\",\"callPart\":120,\"resultPart\":121,\"callTimestamp\":\"2026-10-09T21:46:14.411+00:00\",\"responseTimestamp\":\"2026-10-09T21:46:45.459+00:00\",\"mechanisms\":[\"ptool-quoted-json\"],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false},{\"nativeSession\":\"01a1228c-7bc5-76c2-ac09-038120bb49b5\",\"callPart\":120,\"resultPart\":123,\"callTimestamp\":\"2026-10-09T21:46:14.411+00:00\",\"responseTimestamp\":\"2026-10-09T21:46:50.775+00:00\",\"mechanisms\":[\"ptool-quoted-json\"],\"conditionalAlternatives\":false,\"chain\":{\"cellId\":\"51\",\"yieldPart\":121,\"waitPart\":122,\"originalCallPart\":120},\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":false,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "34952665",
      "nativeSession": "01a122a7-e41a-7f92-9cfc-a825eca90ad8",
      "exitCode": 0,
      "timeout": false,
      "elapsedMs": 444,
      "inputBytes": 14216,
      "stdout": "{\"rows\":[{\"request_id\":\"34952665\",\"owner\":\"su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5\",\"completeOriginalPair\":true,\"pairs\":[{\"nativeSession\":\"01a122a7-e41a-7f92-9cfc-a825eca90ad8\",\"callPart\":109,\"resultPart\":110,\"callTimestamp\":\"2026-10-09T22:12:40.227+00:00\",\"responseTimestamp\":\"2026-10-09T22:12:41.672+00:00\",\"mechanisms\":[\"native-wrapper\"],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"queued\",\"statusAgrees\":true,\"format\":\"toon\",\"requested\":true,\"respawn\":\"queued\",\"completeOriginalPair\":true}],\"receiptState\":\"queued\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "34967591",
      "nativeSession": "01a122c4-d22d-72b3-8c37-5ef6c96c94bb",
      "exitCode": 0,
      "timeout": false,
      "elapsedMs": 375,
      "inputBytes": 29836,
      "stdout": "{\"rows\":[{\"request_id\":\"34967591\",\"owner\":\"su-82c46308-5eb9-4237-9d2d-950d322576c4\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a122c4-d22d-72b3-8c37-5ef6c96c94bb\",\"callPart\":80,\"resultPart\":81,\"callTimestamp\":\"2026-10-09T22:44:14.079+00:00\",\"responseTimestamp\":\"2026-10-09T22:44:17.1+00:00\",\"mechanisms\":[\"native-wrapper\"],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":false,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    }
  ],
  "summary": {
    "targets": 17,
    "newComplete": 6,
    "unresolved": 11,
    "executions": 15,
    "timeouts": 0,
    "failedExecutions": 0,
    "outcomesJoined": 0
  },
  "limits": [
    "Prior78 complete records immutable; original137 denominator unchanged.",
    "Whole116 continuity/eligibility remain unaccepted; outcomesJoined0."
  ]
}
