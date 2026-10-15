---
rel_path: "audits/parked-agent-resumption-2026-10-09/r13-21cold-source-inventory-cold16-v2-424d5.json"
updated_at: 1791879656316
_body: "content"
---

{
  "schemaVersion": "r13-21cold-source-inventory-v2",
  "observedAt": "2026-10-13T08:20:56.237Z",
  "cutoff": "2026-10-10T16:00:36.515Z",
  "cohortHash": "24ff6981fd54f120f96381dd93732ec9c1bfb2101d7eec063119bf85caeb163a",
  "supersedes": "audits/parked-agent-resumption-2026-10-09/r13-21cold-source-inventory-cold15-424d5.json",
  "correction": "Old exact native-index query used tenant papercusp-workspace; writer partRowsFrom stores transcript parts at corpus default. Earlier zero indexedPartOwners measured wrong-scope query, not global source absence.",
  "writerRef": "packages/operator-core/lib/search/session-ingest.ts:1937",
  "corpusScope": "default",
  "intervalLookup": "Only part_kind tool_use, supported by session_turn_parts_owner_ts_tool_use_idx. Broad all-kind owner interval hit 15s57014 and was not saved.",
  "positiveControl": {
    "rows": [
      {
        "workspace_id": "default",
        "session_id": "01a1341c-1442-7170-90e3-d3f2eb0012de"
      }
    ],
    "rowCount": 1,
    "truncated": false,
    "fields": [
      "workspace_id",
      "session_id"
    ],
    "status": "passed"
  },
  "rows": [
    {
      "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
      "witness": "2026-10-09 16:47:39.148+00",
      "custody_native": "01a123f6-6659-74e1-801e-ac4c020a7ca8",
      "corrected_exact_native": {
        "parts": 0,
        "last_ts": null,
        "first_ts": null
      },
      "witness_to_cutoff_tool_use_index": [
        {
          "last_ts": "2026-10-09T16:50:26.627+00:00",
          "first_ts": "2026-10-09T16:47:43.298+00:00",
          "session_id": "01a12170-b27a-7952-9a19-5139980985b3",
          "tool_use_parts": 13
        },
        {
          "last_ts": "2026-10-09T17:34:48.362+00:00",
          "first_ts": "2026-10-09T17:05:59.175+00:00",
          "session_id": "01a121a0-ce00-7b80-878e-b7de5741bed6",
          "tool_use_parts": 86
        },
        {
          "last_ts": "2026-10-09T18:27:50.067+00:00",
          "first_ts": "2026-10-09T18:08:18.239+00:00",
          "session_id": "01a121d9-d398-73d1-9c88-63eb0cf9aec2",
          "tool_use_parts": 55
        },
        {
          "last_ts": "2026-10-09T18:45:19.622+00:00",
          "first_ts": "2026-10-09T18:28:23.114+00:00",
          "session_id": "01a121ec-3bd5-72d3-a76b-bb3efb3cdf99",
          "tool_use_parts": 51
        },
        {
          "last_ts": "2026-10-09T19:09:50.582+00:00",
          "first_ts": "2026-10-09T18:46:41.76+00:00",
          "session_id": "01a121fd-0062-7221-bf7c-66e38bed5d79",
          "tool_use_parts": 57
        },
        {
          "last_ts": "2026-10-09T19:33:42.959+00:00",
          "first_ts": "2026-10-09T19:10:27.356+00:00",
          "session_id": "01a12212-c9fe-7921-bc00-6644cf505bab",
          "tool_use_parts": 57
        },
        {
          "last_ts": "2026-10-09T19:56:45.064+00:00",
          "first_ts": "2026-10-09T19:34:16.85+00:00",
          "session_id": "01a12228-9932-7040-a68b-192083ea9f40",
          "tool_use_parts": 50
        },
        {
          "last_ts": "2026-10-09T20:19:55.221+00:00",
          "first_ts": "2026-10-09T19:57:16.741+00:00",
          "session_id": "01a1223d-8d3b-73d2-ba27-19a009e9bfc7",
          "tool_use_parts": 59
        },
        {
          "last_ts": "2026-10-09T20:42:44.597+00:00",
          "first_ts": "2026-10-09T20:20:53.261+00:00",
          "session_id": "01a12252-f80e-7341-b478-2a4df19537b8",
          "tool_use_parts": 61
        },
        {
          "last_ts": "2026-10-09T21:03:59.711+00:00",
          "first_ts": "2026-10-09T20:43:45.34+00:00",
          "session_id": "01a12267-d15f-7a92-b214-ee072d05705b",
          "tool_use_parts": 51
        },
        {
          "last_ts": "2026-10-09T21:14:58.687+00:00",
          "first_ts": "2026-10-09T21:05:10.136+00:00",
          "session_id": "01a1227b-6132-7f23-a3c0-e69283dfe44e",
          "tool_use_parts": 38
        },
        {
          "last_ts": "2026-10-09T21:25:35.677+00:00",
          "first_ts": "2026-10-09T21:16:02.758+00:00",
          "session_id": "01a12285-443e-7652-939b-e3360d318e49",
          "tool_use_parts": 38
        },
        {
          "last_ts": "2026-10-09T21:48:17.601+00:00",
          "first_ts": "2026-10-09T21:31:29.386+00:00",
          "session_id": "01a12293-9429-7d51-b818-fc4f7f961609",
          "tool_use_parts": 68
        },
        {
          "last_ts": "2026-10-09T22:12:40.227+00:00",
          "first_ts": "2026-10-09T21:53:40.888+00:00",
          "session_id": "01a122a7-e41a-7f92-9cfc-a825eca90ad8",
          "tool_use_parts": 51
        },
        {
          "last_ts": "2026-10-09T22:13:52.136+00:00",
          "first_ts": "2026-10-09T22:13:49.019+00:00",
          "session_id": "01a122ba-5497-7892-b67f-7fe7503b6653",
          "tool_use_parts": 2
        },
        {
          "last_ts": "2026-10-09T22:21:48.394+00:00",
          "first_ts": "2026-10-09T22:18:11.878+00:00",
          "session_id": "01a122be-5a13-7903-8eb8-ad5f4cf55651",
          "tool_use_parts": 13
        },
        {
          "last_ts": "2026-10-09T22:44:59.476+00:00",
          "first_ts": "2026-10-09T22:33:24.549+00:00",
          "session_id": "01a122cc-8067-7150-a1b9-3de1fcac14ca",
          "tool_use_parts": 36
        },
        {
          "last_ts": "2026-10-10T00:51:08.304+00:00",
          "first_ts": "2026-10-10T00:36:38.586+00:00",
          "session_id": "01a1233d-49f6-7fb3-b489-37d80ae709a0",
          "tool_use_parts": 30
        },
        {
          "last_ts": "2026-10-10T01:22:36.494+00:00",
          "first_ts": "2026-10-10T00:52:14.284+00:00",
          "session_id": "01a1234b-2ad5-7db0-86b8-4dcb0f9aa366",
          "tool_use_parts": 74
        },
        {
          "last_ts": "2026-10-10T01:56:55.36+00:00",
          "first_ts": "2026-10-10T01:23:31.772+00:00",
          "session_id": "01a12368-3a80-78b2-b196-a4b27f28a933",
          "tool_use_parts": 63
        },
        {
          "last_ts": "2026-10-10T02:46:05.454+00:00",
          "first_ts": "2026-10-10T02:07:07.76+00:00",
          "session_id": "01a12387-82ae-7063-a36f-e1c3002e11c6",
          "tool_use_parts": 82
        },
        {
          "last_ts": "2026-10-10T03:14:06.073+00:00",
          "first_ts": "2026-10-10T02:47:01.368+00:00",
          "session_id": "01a123b4-6f42-7472-a975-3a2ba6200ff0",
          "tool_use_parts": 48
        },
        {
          "last_ts": "2026-10-10T03:35:22.304+00:00",
          "first_ts": "2026-10-10T03:15:23.358+00:00",
          "session_id": "01a123ce-3d90-7370-b895-0216719d6f67",
          "tool_use_parts": 63
        },
        {
          "last_ts": "2026-10-10T03:57:42.109+00:00",
          "first_ts": "2026-10-10T03:36:18.401+00:00",
          "session_id": "01a123e1-8631-7722-98ac-33f2b3786d4f",
          "tool_use_parts": 74
        }
      ]
    },
    {
      "owner": "su-1415d088-0af5-4299-a5df-8dbfc634335b",
      "witness": "2026-10-10 08:37:35.026+00",
      "custody_native": "01a125c2-9d2b-7283-8c1b-f7e9ac0bedb2",
      "corrected_exact_native": {
        "parts": 62,
        "last_ts": "2026-10-10T12:29:49.158+00:00",
        "first_ts": "2026-10-10T12:21:15.577+00:00"
      },
      "witness_to_cutoff_tool_use_index": [
        {
          "last_ts": "2026-10-10T08:46:08.377+00:00",
          "first_ts": "2026-10-10T08:38:03.656+00:00",
          "session_id": "01a124e2-3f90-7a21-911a-e231ad19ebf7",
          "tool_use_parts": 15
        },
        {
          "last_ts": "2026-10-10T09:09:03.805+00:00",
          "first_ts": "2026-10-10T08:48:02.076+00:00",
          "session_id": "01a124fe-a7f4-7400-82a0-711981ff4174",
          "tool_use_parts": 59
        },
        {
          "last_ts": "2026-10-10T09:34:49.928+00:00",
          "first_ts": "2026-10-10T09:10:01.933+00:00",
          "session_id": "01a12513-3862-7261-ae4a-79265df0b73a",
          "tool_use_parts": 63
        },
        {
          "last_ts": "2026-10-10T10:11:19.628+00:00",
          "first_ts": "2026-10-10T09:37:16.228+00:00",
          "session_id": "01a1252a-e133-7ba0-b5b4-28b9141acbb2",
          "tool_use_parts": 86
        },
        {
          "last_ts": "2026-10-10T11:04:47.029+00:00",
          "first_ts": "2026-10-10T10:14:03.731+00:00",
          "session_id": "01a1254c-cc9a-75c0-9c26-f5e67d2b79a3",
          "tool_use_parts": 122
        },
        {
          "last_ts": "2026-10-10T11:35:57.681+00:00",
          "first_ts": "2026-10-10T11:05:50.795+00:00",
          "session_id": "01a1257d-6598-73a3-97b9-bbaf7f11c96f",
          "tool_use_parts": 72
        },
        {
          "last_ts": "2026-10-10T12:03:32.447+00:00",
          "first_ts": "2026-10-10T11:47:01.435+00:00",
          "session_id": "01a125a3-060c-7e63-b544-a94f51199e74",
          "tool_use_parts": 42
        },
        {
          "last_ts": "2026-10-10T12:29:22.428+00:00",
          "first_ts": "2026-10-10T12:21:22.9+00:00",
          "session_id": "01a125c2-9d2b-7283-8c1b-f7e9ac0bedb2",
          "tool_use_parts": 26
        }
      ]
    },
    {
      "owner": "su-3067d842-6f5a-41ad-bada-9a47df0ea9a6",
      "witness": "2026-10-09 23:49:17.159+00",
      "custody_native": "01a12353-79f3-73f3-aa5d-89fd463e5c5b",
      "corrected_exact_native": {
        "parts": 126,
        "last_ts": "2026-10-10T01:22:02.131+00:00",
        "first_ts": "2026-10-10T01:00:38.879+00:00"
      },
      "witness_to_cutoff_tool_use_index": [
        {
          "last_ts": "2026-10-09T23:50:45.465+00:00",
          "first_ts": "2026-10-09T23:49:24.902+00:00",
          "session_id": "01a12305-f5aa-7263-8a97-999230d0e1b6",
          "tool_use_parts": 5
        },
        {
          "last_ts": "2026-10-10T00:02:01.191+00:00",
          "first_ts": "2026-10-09T23:52:03.184+00:00",
          "session_id": "01a12314-4c2e-7ad3-91f3-46e72c2369a5",
          "tool_use_parts": 46
        },
        {
          "last_ts": "2026-10-10T00:19:53.356+00:00",
          "first_ts": "2026-10-10T00:09:08.741+00:00",
          "session_id": "01a12323-f1b6-76d1-8301-282af62b33fd",
          "tool_use_parts": 64
        },
        {
          "last_ts": "2026-10-10T00:44:30.328+00:00",
          "first_ts": "2026-10-10T00:26:26.33+00:00",
          "session_id": "01a12333-a7a7-7681-ac85-739741d5f755",
          "tool_use_parts": 76
        },
        {
          "last_ts": "2026-10-10T01:00:18.127+00:00",
          "first_ts": "2026-10-10T00:45:25.359+00:00",
          "session_id": "01a12345-1b92-7182-852e-b520dc31a824",
          "tool_use_parts": 41
        },
        {
          "last_ts": "2026-10-10T01:21:28.146+00:00",
          "first_ts": "2026-10-10T01:00:47.243+00:00",
          "session_id": "01a12353-79f3-73f3-aa5d-89fd463e5c5b",
          "tool_use_parts": 59
        }
      ]
    },
    {
      "owner": "su-312c90f2-a3bd-4c92-ac4e-4eae40ae2647",
      "witness": "2026-10-09 23:12:56.031+00",
      "custody_native": "01a124df-4dc0-7741-97a6-73362938b29d",
      "corrected_exact_native": {
        "parts": 102,
        "last_ts": "2026-10-10T08:29:08.212+00:00",
        "first_ts": "2026-10-10T08:12:58.419+00:00"
      },
      "witness_to_cutoff_tool_use_index": [
        {
          "last_ts": "2026-10-09T23:14:40.412+00:00",
          "first_ts": "2026-10-09T23:13:09.794+00:00",
          "session_id": "01a122e2-3803-77b0-9417-4b18e4d73bf4",
          "tool_use_parts": 4
        },
        {
          "last_ts": "2026-10-10T01:07:18+00:00",
          "first_ts": "2026-10-10T00:32:56.041+00:00",
          "session_id": "01a1233a-0409-7e90-9a58-ad8018548b23",
          "tool_use_parts": 80
        },
        {
          "last_ts": "2026-10-10T01:12:36.124+00:00",
          "first_ts": "2026-10-10T01:07:40.221+00:00",
          "session_id": "01a12359-cf27-72a0-8994-4e2010531a8a",
          "tool_use_parts": 15
        },
        {
          "last_ts": "2026-10-10T01:20:50.73+00:00",
          "first_ts": "2026-10-10T01:14:56.758+00:00",
          "session_id": "01a1235f-f94e-76a0-9579-e28090623bc6",
          "tool_use_parts": 23
        },
        {
          "last_ts": "2026-10-10T01:56:03.887+00:00",
          "first_ts": "2026-10-10T01:23:23.58+00:00",
          "session_id": "01a12367-db6e-7d32-b369-cb7e792a16e4",
          "tool_use_parts": 79
        },
        {
          "last_ts": "2026-10-10T02:53:14.857+00:00",
          "first_ts": "2026-10-10T02:06:20.912+00:00",
          "session_id": "01a12386-af1f-7621-951a-227fee9b3df4",
          "tool_use_parts": 119
        },
        {
          "last_ts": "2026-10-10T03:35:07.629+00:00",
          "first_ts": "2026-10-10T03:03:30.94+00:00",
          "session_id": "01a123bb-3402-7a32-ac21-9d650b1634a4",
          "tool_use_parts": 85
        },
        {
          "last_ts": "2026-10-10T03:59:23.479+00:00",
          "first_ts": "2026-10-10T03:36:25.883+00:00",
          "session_id": "01a123e1-9727-72a2-b3d3-c4f01fe4b1ed",
          "tool_use_parts": 60
        },
        {
          "last_ts": "2026-10-10T04:33:30.003+00:00",
          "first_ts": "2026-10-10T04:09:30.838+00:00",
          "session_id": "01a123f7-aafc-7751-aa22-ce65bc0232ba",
          "tool_use_parts": 80
        },
        {
          "last_ts": "2026-10-10T06:26:07.15+00:00",
          "first_ts": "2026-10-10T06:19:17.418+00:00",
          "session_id": "01a12477-222e-7692-9178-c0199854aed1",
          "tool_use_parts": 27
        },
        {
          "last_ts": "2026-10-10T08:28:41.984+00:00",
          "first_ts": "2026-10-10T08:13:04.156+00:00",
          "session_id": "01a124df-4dc0-7741-97a6-73362938b29d",
          "tool_use_parts": 46
        }
      ]
    },
    {
      "owner": "su-449b83a8-a709-43af-9681-768dc6ac744a",
      "witness": "2026-10-09 23:15:12.114+00",
      "custody_native": "01a12358-40b3-7071-afa8-73e105e0851b",
      "corrected_exact_native": {
        "parts": 55,
        "last_ts": "2026-10-10T01:12:00.649+00:00",
        "first_ts": "2026-10-10T01:05:50.134+00:00"
      },
      "witness_to_cutoff_tool_use_index": [
        {
          "last_ts": "2026-10-09T23:43:44.093+00:00",
          "first_ts": "2026-10-09T23:15:24.438+00:00",
          "session_id": "01a122b7-aa4a-7b52-95a3-508a052f77a3",
          "tool_use_parts": 46
        },
        {
          "last_ts": "2026-10-10T00:30:07.402+00:00",
          "first_ts": "2026-10-10T00:14:36.461+00:00",
          "session_id": "01a12329-3110-7ed1-b8cd-0af91f5a7d90",
          "tool_use_parts": 63
        },
        {
          "last_ts": "2026-10-10T00:48:30.393+00:00",
          "first_ts": "2026-10-10T00:33:34.583+00:00",
          "session_id": "01a1233a-5367-7ba3-b8c3-97a25446ca0a",
          "tool_use_parts": 49
        },
        {
          "last_ts": "2026-10-10T01:05:26.418+00:00",
          "first_ts": "2026-10-10T00:49:10.113+00:00",
          "session_id": "01a12348-953f-7483-9589-e1a23948d6f5",
          "tool_use_parts": 66
        },
        {
          "last_ts": "2026-10-10T01:11:48.863+00:00",
          "first_ts": "2026-10-10T01:06:00.378+00:00",
          "session_id": "01a12358-40b3-7071-afa8-73e105e0851b",
          "tool_use_parts": 24
        }
      ]
    },
    {
      "owner": "su-4adf5ebc-6443-4c3c-b704-162275765ff1",
      "witness": "2026-10-10 09:57:44.521+00",
      "custody_native": "01a125b4-15cc-7d41-8499-3be49aaffbe1",
      "corrected_exact_native": {
        "parts": 116,
        "last_ts": "2026-10-10T12:22:24.963+00:00",
        "first_ts": "2026-10-10T12:05:23.645+00:00"
      },
      "witness_to_cutoff_tool_use_index": [
        {
          "last_ts": "2026-10-10T09:58:12.938+00:00",
          "first_ts": "2026-10-10T09:58:00.201+00:00",
          "session_id": "01a1252d-875a-7600-b7c0-29f98f6791f2",
          "tool_use_parts": 2
        },
        {
          "last_ts": "2026-10-10T11:09:23.069+00:00",
          "first_ts": "2026-10-10T09:59:04.456+00:00",
          "session_id": "01a1253f-e361-75a0-a286-aeb68a8fb97d",
          "tool_use_parts": 118
        },
        {
          "last_ts": "2026-10-10T12:22:11.437+00:00",
          "first_ts": "2026-10-10T12:05:30.174+00:00",
          "session_id": "01a125b4-15cc-7d41-8499-3be49aaffbe1",
          "tool_use_parts": 55
        }
      ]
    },
    {
      "owner": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
      "witness": "2026-10-09 18:25:44.655+00",
      "custody_native": "01a12368-8531-7902-b76a-f5453e0f8474",
      "corrected_exact_native": {
        "parts": 145,
        "last_ts": "2026-10-10T01:46:37.323+00:00",
        "first_ts": "2026-10-10T01:23:36.883+00:00"
      },
      "witness_to_cutoff_tool_use_index": [
        {
          "last_ts": "2026-10-09T18:26:36.52+00:00",
          "first_ts": "2026-10-09T18:26:11.856+00:00",
          "session_id": "01a121da-e5a4-75a1-bc1b-c2a446588a23",
          "tool_use_parts": 2
        },
        {
          "last_ts": "2026-10-09T18:45:11.787+00:00",
          "first_ts": "2026-10-09T18:27:21.213+00:00",
          "session_id": "01a121eb-3503-7542-b2aa-9e568eec1d49",
          "tool_use_parts": 59
        },
        {
          "last_ts": "2026-10-09T19:18:29.622+00:00",
          "first_ts": "2026-10-09T18:45:59.209+00:00",
          "session_id": "01a121fc-57f2-7932-b336-bb7206c0e5a8",
          "tool_use_parts": 103
        },
        {
          "last_ts": "2026-10-09T19:37:49.894+00:00",
          "first_ts": "2026-10-09T19:19:03.921+00:00",
          "session_id": "01a1221a-975e-7780-8519-b95858a875be",
          "tool_use_parts": 62
        },
        {
          "last_ts": "2026-10-09T20:10:57.792+00:00",
          "first_ts": "2026-10-09T19:39:00.562+00:00",
          "session_id": "01a1222c-d097-7e31-abe1-3d9adafedc1d",
          "tool_use_parts": 71
        },
        {
          "last_ts": "2026-10-09T20:35:41.246+00:00",
          "first_ts": "2026-10-09T20:12:39.338+00:00",
          "session_id": "01a1224b-a4da-7813-8679-5959b1e641f6",
          "tool_use_parts": 68
        },
        {
          "last_ts": "2026-10-09T21:00:18.173+00:00",
          "first_ts": "2026-10-09T20:37:18.952+00:00",
          "session_id": "01a12261-ef91-7472-9b28-a718d9ea4437",
          "tool_use_parts": 53
        },
        {
          "last_ts": "2026-10-09T21:22:43.468+00:00",
          "first_ts": "2026-10-09T21:01:49.786+00:00",
          "session_id": "01a12278-2e15-7521-82f2-816b032ce988",
          "tool_use_parts": 52
        },
        {
          "last_ts": "2026-10-09T21:47:06.35+00:00",
          "first_ts": "2026-10-09T21:23:55.081+00:00",
          "session_id": "01a1228c-7bc5-76c2-ac09-038120bb49b5",
          "tool_use_parts": 56
        },
        {
          "last_ts": "2026-10-09T22:12:58.961+00:00",
          "first_ts": "2026-10-09T21:48:27.033+00:00",
          "session_id": "01a122a2-e60d-7470-b100-cfa8a3083558",
          "tool_use_parts": 66
        },
        {
          "last_ts": "2026-10-09T22:34:26.518+00:00",
          "first_ts": "2026-10-09T22:24:08.489+00:00",
          "session_id": "01a122c3-b67b-7e12-a835-3aae3548eb00",
          "tool_use_parts": 37
        },
        {
          "last_ts": "2026-10-09T23:01:45.749+00:00",
          "first_ts": "2026-10-09T22:35:06.233+00:00",
          "session_id": "01a122cd-d7dd-78f0-88d9-88eb04565cbe",
          "tool_use_parts": 74
        },
        {
          "last_ts": "2026-10-09T23:25:28.119+00:00",
          "first_ts": "2026-10-09T23:02:27.752+00:00",
          "session_id": "01a122e6-e50e-77c1-8895-9892175ba0e9",
          "tool_use_parts": 53
        },
        {
          "last_ts": "2026-10-09T23:39:38.752+00:00",
          "first_ts": "2026-10-09T23:25:50.432+00:00",
          "session_id": "01a122fc-9a60-7772-8189-7fdc8cf876bb",
          "tool_use_parts": 43
        },
        {
          "last_ts": "2026-10-09T23:59:03.187+00:00",
          "first_ts": "2026-10-09T23:40:28.772+00:00",
          "session_id": "01a12309-a334-7de2-ba2d-b2e49d793aaa",
          "tool_use_parts": 69
        },
        {
          "last_ts": "2026-10-10T00:18:57.861+00:00",
          "first_ts": "2026-10-10T00:00:05.081+00:00",
          "session_id": "01a1231b-9a29-7b30-bb0e-4224ce54891a",
          "tool_use_parts": 78
        },
        {
          "last_ts": "2026-10-10T00:30:22.357+00:00",
          "first_ts": "2026-10-10T00:19:56.73+00:00",
          "session_id": "01a1232d-a990-7d60-bacf-7a5d4ed082fb",
          "tool_use_parts": 55
        },
        {
          "last_ts": "2026-10-10T00:49:25.882+00:00",
          "first_ts": "2026-10-10T00:31:10.083+00:00",
          "session_id": "01a12337-f502-7103-9a8a-d2d14c76be56",
          "tool_use_parts": 66
        },
        {
          "last_ts": "2026-10-10T01:22:54.993+00:00",
          "first_ts": "2026-10-10T00:50:11.917+00:00",
          "session_id": "01a12349-7117-7211-955a-cc49fb6d9292",
          "tool_use_parts": 83
        },
        {
          "last_ts": "2026-10-10T01:46:29.88+00:00",
          "first_ts": "2026-10-10T01:23:45.554+00:00",
          "session_id": "01a12368-8531-7902-b76a-f5453e0f8474",
          "tool_use_parts": 66
        }
      ]
    },
    {
      "owner": "su-82c46308-5eb9-4237-9d2d-950d322576c4",
      "witness": "2026-10-09 20:16:13.818+00",
      "custody_native": "01a12356-659d-7871-a5dd-c4a744655ff4",
      "corrected_exact_native": {
        "parts": 50,
        "last_ts": "2026-10-10T01:13:37.236+00:00",
        "first_ts": "2026-10-10T01:03:59.013+00:00"
      },
      "witness_to_cutoff_tool_use_index": [
        {
          "last_ts": "2026-10-09T20:18:43.281+00:00",
          "first_ts": "2026-10-09T20:16:23.512+00:00",
          "session_id": "01a1222f-4f0d-71b2-b283-fb4c74b79830",
          "tool_use_parts": 5
        },
        {
          "last_ts": "2026-10-09T20:46:17.225+00:00",
          "first_ts": "2026-10-09T20:19:36.142+00:00",
          "session_id": "01a12252-05d0-7690-bfdd-605fe7f863c1",
          "tool_use_parts": 63
        },
        {
          "last_ts": "2026-10-09T21:08:07.005+00:00",
          "first_ts": "2026-10-09T20:52:27.211+00:00",
          "session_id": "01a1226b-ab21-7403-a3e6-f8b16c720c6f",
          "tool_use_parts": 42
        },
        {
          "last_ts": "2026-10-09T21:32:44.963+00:00",
          "first_ts": "2026-10-09T21:09:10.462+00:00",
          "session_id": "01a1227f-16a0-71f1-a58a-170cac7d2a65",
          "tool_use_parts": 59
        },
        {
          "last_ts": "2026-10-09T22:10:58.161+00:00",
          "first_ts": "2026-10-09T21:47:21.799+00:00",
          "session_id": "01a122a2-715a-7c80-87ec-c84aa8ee9391",
          "tool_use_parts": 47
        },
        {
          "last_ts": "2026-10-09T22:13:51.126+00:00",
          "first_ts": "2026-10-09T22:12:04.95+00:00",
          "session_id": "01a122b8-8a0e-7811-8a55-eeccb1901726",
          "tool_use_parts": 12
        },
        {
          "last_ts": "2026-10-09T22:44:14.079+00:00",
          "first_ts": "2026-10-09T22:24:53.59+00:00",
          "session_id": "01a122c4-d22d-72b3-8c37-5ef6c96c94bb",
          "tool_use_parts": 38
        },
        {
          "last_ts": "2026-10-09T23:07:09.785+00:00",
          "first_ts": "2026-10-09T22:45:17.912+00:00",
          "session_id": "01a122d6-ff62-75c3-a4ee-384dd3040a57",
          "tool_use_parts": 62
        },
        {
          "last_ts": "2026-10-09T23:30:10.481+00:00",
          "first_ts": "2026-10-09T23:08:33.453+00:00",
          "session_id": "01a122ec-4cda-7080-9411-78e5617480bc",
          "tool_use_parts": 56
        },
        {
          "last_ts": "2026-10-09T23:41:15.655+00:00",
          "first_ts": "2026-10-09T23:34:29.516+00:00",
          "session_id": "01a12304-695b-7953-93a8-2de8e4e547f6",
          "tool_use_parts": 25
        },
        {
          "last_ts": "2026-10-09T23:59:11.198+00:00",
          "first_ts": "2026-10-09T23:42:14.569+00:00",
          "session_id": "01a1230b-3f77-7ee2-bfaa-13a525adb292",
          "tool_use_parts": 66
        },
        {
          "last_ts": "2026-10-10T00:24:39.497+00:00",
          "first_ts": "2026-10-10T00:03:36.322+00:00",
          "session_id": "01a1231e-b6d5-7ee0-8ce8-73fb43067a42",
          "tool_use_parts": 67
        },
        {
          "last_ts": "2026-10-10T00:39:37.524+00:00",
          "first_ts": "2026-10-10T00:25:28.747+00:00",
          "session_id": "01a12332-bcc7-7303-ae0d-4c748ccc0059",
          "tool_use_parts": 61
        },
        {
          "last_ts": "2026-10-10T01:03:16.53+00:00",
          "first_ts": "2026-10-10T00:44:16.68+00:00",
          "session_id": "01a12344-1bcc-7313-bd5f-46510e73c99c",
          "tool_use_parts": 59
        },
        {
          "last_ts": "2026-10-10T01:13:17.851+00:00",
          "first_ts": "2026-10-10T01:04:16.151+00:00",
          "session_id": "01a12356-659d-7871-a5dd-c4a744655ff4",
          "tool_use_parts": 22
        }
      ]
    },
    {
      "owner": "su-8d2cb6cc-8f27-4a25-8541-b00927471b94",
      "witness": "2026-10-10 03:26:03.2+00",
      "custody_native": "01a123fe-6eda-7640-9dc5-7f91366ee84e",
      "corrected_exact_native": {
        "parts": 160,
        "last_ts": "2026-10-10T04:28:12.801+00:00",
        "first_ts": "2026-10-10T04:07:21.264+00:00"
      },
      "witness_to_cutoff_tool_use_index": [
        {
          "last_ts": "2026-10-10T03:31:57.051+00:00",
          "first_ts": "2026-10-10T03:26:11.567+00:00",
          "session_id": "01a12390-52f7-7fa2-b464-cc80e12d14e2",
          "tool_use_parts": 5
        },
        {
          "last_ts": "2026-10-10T04:28:03.242+00:00",
          "first_ts": "2026-10-10T04:07:27.184+00:00",
          "session_id": "01a123fe-6eda-7640-9dc5-7f91366ee84e",
          "tool_use_parts": 73
        }
      ]
    },
    {
      "owner": "su-960a52e7-9b11-42ac-8fe9-7e5e7e0da441",
      "witness": "2026-10-10 00:17:12.298+00",
      "custody_native": "01a12354-76df-7230-8a3e-7b5bc95a62ef",
      "corrected_exact_native": {
        "parts": 68,
        "last_ts": "2026-10-10T01:18:17.799+00:00",
        "first_ts": "2026-10-10T01:01:41.779+00:00"
      },
      "witness_to_cutoff_tool_use_index": [
        {
          "last_ts": "2026-10-10T00:17:28.795+00:00",
          "first_ts": "2026-10-10T00:17:28.795+00:00",
          "session_id": "01a12315-a40e-7280-a1e8-9f2ac48b1d4e",
          "tool_use_parts": 1
        },
        {
          "last_ts": "2026-10-10T00:35:01.359+00:00",
          "first_ts": "2026-10-10T00:18:10.546+00:00",
          "session_id": "01a1232c-37f8-7e61-a664-1dbf34681ab9",
          "tool_use_parts": 51
        },
        {
          "last_ts": "2026-10-10T00:46:47.237+00:00",
          "first_ts": "2026-10-10T00:36:18.433+00:00",
          "session_id": "01a1233c-b7dd-7830-9fb8-36c3e2f96590",
          "tool_use_parts": 32
        },
        {
          "last_ts": "2026-10-10T00:58:02.397+00:00",
          "first_ts": "2026-10-10T00:49:13.965+00:00",
          "session_id": "01a12348-a4a0-7a43-9219-40acd654c90b",
          "tool_use_parts": 39
        },
        {
          "last_ts": "2026-10-10T01:17:53.241+00:00",
          "first_ts": "2026-10-10T01:01:49.573+00:00",
          "session_id": "01a12354-76df-7230-8a3e-7b5bc95a62ef",
          "tool_use_parts": 29
        }
      ]
    },
    {
      "owner": "su-ab8cc07f-e903-4467-ac45-a32149258170",
      "witness": "2026-10-09 17:45:47.12+00",
      "custody_native": "01a12360-da31-7753-8b52-6276d176e0d8",
      "corrected_exact_native": {
        "parts": 106,
        "last_ts": "2026-10-10T01:29:09.053+00:00",
        "first_ts": "2026-10-10T01:15:19.67+00:00"
      },
      "witness_to_cutoff_tool_use_index": [
        {
          "last_ts": "2026-10-09T17:46:26.055+00:00",
          "first_ts": "2026-10-09T17:45:52.06+00:00",
          "session_id": "01a121ba-c573-7653-bef3-77028f51c4b1",
          "tool_use_parts": 3
        },
        {
          "last_ts": "2026-10-09T18:11:34.824+00:00",
          "first_ts": "2026-10-09T17:47:41.746+00:00",
          "session_id": "01a121c6-8c51-7341-9f03-314b22bd77e4",
          "tool_use_parts": 83
        },
        {
          "last_ts": "2026-10-09T18:35:15.556+00:00",
          "first_ts": "2026-10-09T18:12:32.28+00:00",
          "session_id": "01a121dd-4682-7970-a877-d48365ae96af",
          "tool_use_parts": 62
        },
        {
          "last_ts": "2026-10-09T18:55:18.853+00:00",
          "first_ts": "2026-10-09T18:36:05.404+00:00",
          "session_id": "01a121f3-2211-7912-b4f6-78fd26b41ca4",
          "tool_use_parts": 64
        },
        {
          "last_ts": "2026-10-09T19:39:03.291+00:00",
          "first_ts": "2026-10-09T19:14:12.432+00:00",
          "session_id": "01a12215-f913-74d0-8930-463399a84938",
          "tool_use_parts": 62
        },
        {
          "last_ts": "2026-10-09T19:48:38.301+00:00",
          "first_ts": "2026-10-09T19:40:40.569+00:00",
          "session_id": "01a1222e-5111-7393-9400-6fffdc59f68f",
          "tool_use_parts": 24
        },
        {
          "last_ts": "2026-10-09T20:21:25.383+00:00",
          "first_ts": "2026-10-09T19:49:34.252+00:00",
          "session_id": "01a12236-1107-7490-8034-f4da1c37b581",
          "tool_use_parts": 79
        },
        {
          "last_ts": "2026-10-09T20:38:25.999+00:00",
          "first_ts": "2026-10-09T20:21:57.108+00:00",
          "session_id": "01a12254-3c2e-7f12-abef-2dfea70788c5",
          "tool_use_parts": 36
        },
        {
          "last_ts": "2026-10-09T21:01:10.291+00:00",
          "first_ts": "2026-10-09T20:39:37.302+00:00",
          "session_id": "01a12263-9cc1-78b0-bc03-6f19c79a2fb0",
          "tool_use_parts": 40
        },
        {
          "last_ts": "2026-10-09T21:26:38.45+00:00",
          "first_ts": "2026-10-09T21:02:41.203+00:00",
          "session_id": "01a12278-da25-73f1-a497-e842752fcdfb",
          "tool_use_parts": 34
        },
        {
          "last_ts": "2026-10-09T21:52:42.792+00:00",
          "first_ts": "2026-10-09T21:32:01.353+00:00",
          "session_id": "01a12293-ab29-75c0-82be-153c95acf48f",
          "tool_use_parts": 53
        },
        {
          "last_ts": "2026-10-09T23:25:28.625+00:00",
          "first_ts": "2026-10-09T23:24:07.998+00:00",
          "session_id": "01a122fa-3a55-7751-b848-07dd6fa005e6",
          "tool_use_parts": 6
        },
        {
          "last_ts": "2026-10-10T00:25:34.435+00:00",
          "first_ts": "2026-10-10T00:02:11.97+00:00",
          "session_id": "01a1231d-e28a-7d50-bed3-d058a9d8d860",
          "tool_use_parts": 64
        },
        {
          "last_ts": "2026-10-10T00:50:05.216+00:00",
          "first_ts": "2026-10-10T00:32:48.054+00:00",
          "session_id": "01a12339-7862-78e3-b4af-30c8e8bbe6f7",
          "tool_use_parts": 75
        },
        {
          "last_ts": "2026-10-10T01:14:31.403+00:00",
          "first_ts": "2026-10-10T00:50:33.575+00:00",
          "session_id": "01a1234a-0d22-76c3-9b5c-17845a8123b4",
          "tool_use_parts": 72
        },
        {
          "last_ts": "2026-10-10T01:28:47.905+00:00",
          "first_ts": "2026-10-10T01:15:31.458+00:00",
          "session_id": "01a12360-da31-7753-8b52-6276d176e0d8",
          "tool_use_parts": 48
        }
      ]
    },
    {
      "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
      "witness": "2026-10-09 18:30:18.913+00",
      "custody_native": "01a12357-33fa-76b1-9add-840d4be15ec1",
      "corrected_exact_native": {
        "parts": 125,
        "last_ts": "2026-10-10T01:28:24.994+00:00",
        "first_ts": "2026-10-10T01:04:41.378+00:00"
      },
      "witness_to_cutoff_tool_use_index": [
        {
          "last_ts": "2026-10-09T18:30:31.746+00:00",
          "first_ts": "2026-10-09T18:30:31.746+00:00",
          "session_id": "01a121d3-5bd6-79d0-b0a0-ed2cca18cc7f",
          "tool_use_parts": 1
        },
        {
          "last_ts": "2026-10-09T18:48:47.77+00:00",
          "first_ts": "2026-10-09T18:31:15.48+00:00",
          "session_id": "01a121ee-ccf8-7492-b66e-823f81919801",
          "tool_use_parts": 56
        },
        {
          "last_ts": "2026-10-09T19:12:07.095+00:00",
          "first_ts": "2026-10-09T18:49:36.983+00:00",
          "session_id": "01a121ff-af87-7f10-9df2-8153fd97ec8c",
          "tool_use_parts": 77
        },
        {
          "last_ts": "2026-10-09T19:21:58.669+00:00",
          "first_ts": "2026-10-09T19:13:58.723+00:00",
          "session_id": "01a12215-f0db-7ea1-8d63-45fc2819373a",
          "tool_use_parts": 27
        },
        {
          "last_ts": "2026-10-09T19:33:01.511+00:00",
          "first_ts": "2026-10-09T19:22:41.532+00:00",
          "session_id": "01a1221d-8381-7943-9379-4cfecb502aff",
          "tool_use_parts": 39
        },
        {
          "last_ts": "2026-10-09T19:39:58.443+00:00",
          "first_ts": "2026-10-09T19:39:04.897+00:00",
          "session_id": "01a1222b-a177-74b1-aba5-2b2eecbce23d",
          "tool_use_parts": 5
        },
        {
          "last_ts": "2026-10-09T20:45:51.713+00:00",
          "first_ts": "2026-10-09T20:23:30.838+00:00",
          "session_id": "01a12255-9239-7cd0-9598-0ff98ae81246",
          "tool_use_parts": 78
        },
        {
          "last_ts": "2026-10-09T20:54:18.579+00:00",
          "first_ts": "2026-10-09T20:46:40.64+00:00",
          "session_id": "01a1226a-9483-7c31-ab62-e5fd8a71ffcc",
          "tool_use_parts": 39
        },
        {
          "last_ts": "2026-10-09T21:10:08.392+00:00",
          "first_ts": "2026-10-09T20:55:07.818+00:00",
          "session_id": "01a12272-4c98-7082-adb0-1dcb07640a02",
          "tool_use_parts": 42
        },
        {
          "last_ts": "2026-10-09T21:37:07.892+00:00",
          "first_ts": "2026-10-09T21:21:22.178+00:00",
          "session_id": "01a1228a-51bb-7100-b09e-114c38bf3712",
          "tool_use_parts": 66
        },
        {
          "last_ts": "2026-10-09T21:53:50.949+00:00",
          "first_ts": "2026-10-09T21:37:54.829+00:00",
          "session_id": "01a12299-6e21-74d3-8071-d47e5fd8490c",
          "tool_use_parts": 62
        },
        {
          "last_ts": "2026-10-09T22:11:31.473+00:00",
          "first_ts": "2026-10-09T21:54:42.733+00:00",
          "session_id": "01a122a8-bb6b-77a1-93fa-a6b691ae9157",
          "tool_use_parts": 52
        },
        {
          "last_ts": "2026-10-09T22:13:33.717+00:00",
          "first_ts": "2026-10-09T22:12:18.077+00:00",
          "session_id": "01a122b8-f39e-7d30-b4fd-3ad80fe854c2",
          "tool_use_parts": 8
        },
        {
          "last_ts": "2026-10-09T22:22:13.909+00:00",
          "first_ts": "2026-10-09T22:18:38.883+00:00",
          "session_id": "01a122bf-1704-7941-b80c-eb51e6a9e70f",
          "tool_use_parts": 13
        },
        {
          "last_ts": "2026-10-09T22:38:40.409+00:00",
          "first_ts": "2026-10-09T22:33:10.417+00:00",
          "session_id": "01a122cc-4914-74d3-ac1d-3e8ebd626992",
          "tool_use_parts": 14
        },
        {
          "last_ts": "2026-10-09T23:09:32.085+00:00",
          "first_ts": "2026-10-09T22:41:56.319+00:00",
          "session_id": "01a122d3-f5e7-7d62-bd7a-ffb4d0707a7d",
          "tool_use_parts": 112
        },
        {
          "last_ts": "2026-10-09T23:30:42.854+00:00",
          "first_ts": "2026-10-09T23:10:30.974+00:00",
          "session_id": "01a122ee-350a-77d0-b4b1-f2b553271268",
          "tool_use_parts": 54
        },
        {
          "last_ts": "2026-10-09T23:50:34.264+00:00",
          "first_ts": "2026-10-09T23:31:04.866+00:00",
          "session_id": "01a12301-650c-73c2-af6d-661ef6de7e01",
          "tool_use_parts": 72
        },
        {
          "last_ts": "2026-10-09T23:52:47.823+00:00",
          "first_ts": "2026-10-09T23:51:39.207+00:00",
          "session_id": "01a12313-eb4f-7c40-af79-b54e337d5075",
          "tool_use_parts": 9
        },
        {
          "last_ts": "2026-10-10T00:14:24.785+00:00",
          "first_ts": "2026-10-09T23:53:28.462+00:00",
          "session_id": "01a12315-8b95-7243-8949-1b20acf248cd",
          "tool_use_parts": 52
        },
        {
          "last_ts": "2026-10-10T00:33:31+00:00",
          "first_ts": "2026-10-10T00:15:21.344+00:00",
          "session_id": "01a12329-777a-7b80-8fc3-ab01535f10ae",
          "tool_use_parts": 45
        },
        {
          "last_ts": "2026-10-10T01:03:48.578+00:00",
          "first_ts": "2026-10-10T00:34:08.056+00:00",
          "session_id": "01a1233a-d987-7c81-ab19-ebb8b26a4768",
          "tool_use_parts": 43
        },
        {
          "last_ts": "2026-10-10T01:28:18.007+00:00",
          "first_ts": "2026-10-10T01:04:50.594+00:00",
          "session_id": "01a12357-33fa-76b1-9add-840d4be15ec1",
          "tool_use_parts": 56
        }
      ]
    },
    {
      "owner": "su-b7ae044b-c702-4275-8857-d8c0943bc6f6",
      "witness": "2026-10-10 00:58:16.474+00",
      "custody_native": "01a123cc-f94e-7762-904c-3a3fd9ed047f",
      "corrected_exact_native": {
        "parts": 104,
        "last_ts": "2026-10-10T03:23:44.614+00:00",
        "first_ts": "2026-10-10T03:13:21.437+00:00"
      },
      "witness_to_cutoff_tool_use_index": [
        {
          "last_ts": "2026-10-10T01:17:42.88+00:00",
          "first_ts": "2026-10-10T00:58:40.805+00:00",
          "session_id": "01a1234d-de07-7972-bec8-6771e5714d38",
          "tool_use_parts": 46
        },
        {
          "last_ts": "2026-10-10T01:42:38.818+00:00",
          "first_ts": "2026-10-10T01:21:37.375+00:00",
          "session_id": "01a12366-709f-7563-883f-29a8b509fa28",
          "tool_use_parts": 42
        },
        {
          "last_ts": "2026-10-10T02:04:33.644+00:00",
          "first_ts": "2026-10-10T01:44:08.611+00:00",
          "session_id": "01a1237a-71ff-7d31-a6a7-3a445ad79f41",
          "tool_use_parts": 46
        },
        {
          "last_ts": "2026-10-10T03:23:30.377+00:00",
          "first_ts": "2026-10-10T03:13:26.577+00:00",
          "session_id": "01a123cc-f94e-7762-904c-3a3fd9ed047f",
          "tool_use_parts": 48
        }
      ]
    },
    {
      "owner": "su-ba80f2f7-46f6-4aec-b99a-21e02460933f",
      "witness": "2026-10-09 20:38:47.049+00",
      "custody_native": "01a1234f-fefc-7753-8af9-f3e0243ffe82",
      "corrected_exact_native": {
        "parts": 55,
        "last_ts": "2026-10-10T01:05:51.995+00:00",
        "first_ts": "2026-10-10T00:56:49.006+00:00"
      },
      "witness_to_cutoff_tool_use_index": [
        {
          "last_ts": "2026-10-09T20:40:59.992+00:00",
          "first_ts": "2026-10-09T20:39:01.114+00:00",
          "session_id": "01a12246-1d69-71f3-aa04-77e7f6c9aeda",
          "tool_use_parts": 5
        },
        {
          "last_ts": "2026-10-09T21:02:56.188+00:00",
          "first_ts": "2026-10-09T20:42:06.726+00:00",
          "session_id": "01a12266-3e63-7283-821f-8cbcd5c543fa",
          "tool_use_parts": 66
        },
        {
          "last_ts": "2026-10-09T21:26:19.179+00:00",
          "first_ts": "2026-10-09T21:07:50.856+00:00",
          "session_id": "01a1227a-27b3-79c3-990b-b101d7ea9a6c",
          "tool_use_parts": 59
        },
        {
          "last_ts": "2026-10-09T21:41:28.062+00:00",
          "first_ts": "2026-10-09T21:27:31.87+00:00",
          "session_id": "01a1228f-d136-7000-8547-7c72440ae51d",
          "tool_use_parts": 38
        },
        {
          "last_ts": "2026-10-09T22:13:49.789+00:00",
          "first_ts": "2026-10-09T21:51:48.193+00:00",
          "session_id": "01a122a5-fe45-7702-95a4-fcdcd34f15c9",
          "tool_use_parts": 49
        },
        {
          "last_ts": "2026-10-09T23:10:01.149+00:00",
          "first_ts": "2026-10-09T22:47:56.018+00:00",
          "session_id": "01a122d9-d539-7ed1-918a-41bcc5b9f9c4",
          "tool_use_parts": 56
        },
        {
          "last_ts": "2026-10-09T23:32:00.831+00:00",
          "first_ts": "2026-10-09T23:11:14.075+00:00",
          "session_id": "01a122ee-ee80-77b3-9aed-03658f2afb68",
          "tool_use_parts": 47
        },
        {
          "last_ts": "2026-10-09T23:39:04.54+00:00",
          "first_ts": "2026-10-09T23:32:26.675+00:00",
          "session_id": "01a12302-9220-7a31-94cd-e744f4253db3",
          "tool_use_parts": 16
        },
        {
          "last_ts": "2026-10-10T00:00:56.092+00:00",
          "first_ts": "2026-10-09T23:44:09.665+00:00",
          "session_id": "01a1230d-1045-7c82-a787-e30895ea858f",
          "tool_use_parts": 49
        },
        {
          "last_ts": "2026-10-10T00:17:10.916+00:00",
          "first_ts": "2026-10-10T00:03:34.366+00:00",
          "session_id": "01a1231e-d0bc-7383-8acd-6bbc1e0db36d",
          "tool_use_parts": 46
        },
        {
          "last_ts": "2026-10-10T00:34:01.218+00:00",
          "first_ts": "2026-10-10T00:21:49.991+00:00",
          "session_id": "01a1232f-8761-7bf1-b816-3d732509331d",
          "tool_use_parts": 57
        },
        {
          "last_ts": "2026-10-10T00:44:20.055+00:00",
          "first_ts": "2026-10-10T00:37:56.949+00:00",
          "session_id": "01a1233e-46dd-7ec0-b948-1cf79f2817f5",
          "tool_use_parts": 18
        },
        {
          "last_ts": "2026-10-10T00:52:55.936+00:00",
          "first_ts": "2026-10-10T00:50:08.588+00:00",
          "session_id": "01a12349-6c94-7450-a4ad-9c470b189b1d",
          "tool_use_parts": 12
        },
        {
          "last_ts": "2026-10-10T01:05:24.846+00:00",
          "first_ts": "2026-10-10T00:56:55.179+00:00",
          "session_id": "01a1234f-fefc-7753-8af9-f3e0243ffe82",
          "tool_use_parts": 24
        }
      ]
    },
    {
      "owner": "su-d88420f0-c0b4-4dc7-92c7-f60ab3ddab44",
      "witness": "2026-10-10 06:24:03.423+00",
      "custody_native": "01a125e7-53fd-7891-a404-21f7f9ad9f43",
      "corrected_exact_native": {
        "parts": 72,
        "last_ts": "2026-10-10T13:13:43.807+00:00",
        "first_ts": "2026-10-10T13:01:48.225+00:00"
      },
      "witness_to_cutoff_tool_use_index": [
        {
          "last_ts": "2026-10-10T06:26:14.715+00:00",
          "first_ts": "2026-10-10T06:24:15.173+00:00",
          "session_id": "01a12469-f05a-7311-a781-0396e728fddc",
          "tool_use_parts": 5
        },
        {
          "last_ts": "2026-10-10T06:49:16.713+00:00",
          "first_ts": "2026-10-10T06:30:13.844+00:00",
          "session_id": "01a12480-c8dd-7590-a3d7-d796dd0b8726",
          "tool_use_parts": 52
        },
        {
          "last_ts": "2026-10-10T07:37:44.971+00:00",
          "first_ts": "2026-10-10T06:55:39.016+00:00",
          "session_id": "01a12498-129e-7420-ad23-b8c89cad3c5a",
          "tool_use_parts": 65
        },
        {
          "last_ts": "2026-10-10T08:14:39.018+00:00",
          "first_ts": "2026-10-10T07:38:47.014+00:00",
          "session_id": "01a124bf-7bab-7351-93bf-9daa6283b81e",
          "tool_use_parts": 95
        },
        {
          "last_ts": "2026-10-10T08:45:17.566+00:00",
          "first_ts": "2026-10-10T08:16:29.647+00:00",
          "session_id": "01a124e1-9e74-7911-a07c-c48f1d4db388",
          "tool_use_parts": 72
        },
        {
          "last_ts": "2026-10-10T09:07:53.766+00:00",
          "first_ts": "2026-10-10T08:46:34.817+00:00",
          "session_id": "01a124fd-8c3b-7333-9add-c36106e10ed6",
          "tool_use_parts": 71
        },
        {
          "last_ts": "2026-10-10T09:42:33.374+00:00",
          "first_ts": "2026-10-10T09:14:05.454+00:00",
          "session_id": "01a12517-0350-7a33-b327-d35d8394ea3a",
          "tool_use_parts": 62
        },
        {
          "last_ts": "2026-10-10T10:23:48.321+00:00",
          "first_ts": "2026-10-10T09:43:54.388+00:00",
          "session_id": "01a12531-ca04-75f2-a94c-e14631082377",
          "tool_use_parts": 78
        },
        {
          "last_ts": "2026-10-10T10:44:14.936+00:00",
          "first_ts": "2026-10-10T10:24:22.354+00:00",
          "session_id": "01a12557-7b7e-7cc3-a15b-35d654c7e082",
          "tool_use_parts": 52
        },
        {
          "last_ts": "2026-10-10T10:52:52.451+00:00",
          "first_ts": "2026-10-10T10:51:55.652+00:00",
          "session_id": "01a12570-2b80-7c60-bb69-99ae944a3624",
          "tool_use_parts": 5
        },
        {
          "last_ts": "2026-10-10T11:25:42.144+00:00",
          "first_ts": "2026-10-10T11:11:48.351+00:00",
          "session_id": "01a12582-dda8-79f3-af81-2045845e9e2c",
          "tool_use_parts": 43
        },
        {
          "last_ts": "2026-10-10T11:46:14.99+00:00",
          "first_ts": "2026-10-10T11:37:12.641+00:00",
          "session_id": "01a1259a-1db8-71c3-9d6f-33d956d2b067",
          "tool_use_parts": 29
        },
        {
          "last_ts": "2026-10-10T11:56:58.555+00:00",
          "first_ts": "2026-10-10T11:56:23.571+00:00",
          "session_id": "01a125a9-6631-7ad2-83f4-4ba4b99dddb0",
          "tool_use_parts": 5
        },
        {
          "last_ts": "2026-10-10T12:22:18.461+00:00",
          "first_ts": "2026-10-10T12:21:03.103+00:00",
          "session_id": "01a125c1-c58c-7823-9c3b-9299b58b2961",
          "tool_use_parts": 4
        },
        {
          "last_ts": "2026-10-10T13:13:28.489+00:00",
          "first_ts": "2026-10-10T13:01:55.112+00:00",
          "session_id": "01a125e7-53fd-7891-a404-21f7f9ad9f43",
          "tool_use_parts": 30
        }
      ]
    },
    {
      "owner": "su-ddb4cbf4-2581-4f7c-8d6a-efbb712bd295",
      "witness": "2026-10-09 21:52:52.005+00",
      "custody_native": "01a12356-4811-7080-a02e-863980775e9c",
      "corrected_exact_native": {
        "parts": 137,
        "last_ts": "2026-10-10T01:26:07.982+00:00",
        "first_ts": "2026-10-10T01:03:47.081+00:00"
      },
      "witness_to_cutoff_tool_use_index": [
        {
          "last_ts": "2026-10-09T21:57:59.542+00:00",
          "first_ts": "2026-10-09T21:53:07.076+00:00",
          "session_id": "01a12288-fdee-7571-b7d5-2a88a957d769",
          "tool_use_parts": 14
        },
        {
          "last_ts": "2026-10-09T22:13:51.484+00:00",
          "first_ts": "2026-10-09T22:07:58.184+00:00",
          "session_id": "01a122ac-7436-7aa0-b80e-c7688cecab72",
          "tool_use_parts": 20
        },
        {
          "last_ts": "2026-10-09T22:45:02.268+00:00",
          "first_ts": "2026-10-09T22:24:53.378+00:00",
          "session_id": "01a122c4-ab61-7441-ae2f-4df2cabf0193",
          "tool_use_parts": 47
        },
        {
          "last_ts": "2026-10-09T23:11:24.355+00:00",
          "first_ts": "2026-10-09T22:45:55.827+00:00",
          "session_id": "01a122d7-8cb3-7563-92a2-4180bfbb7181",
          "tool_use_parts": 95
        },
        {
          "last_ts": "2026-10-09T23:37:37.573+00:00",
          "first_ts": "2026-10-09T23:12:31.571+00:00",
          "session_id": "01a122ef-e794-7141-ab72-5d02dedba04e",
          "tool_use_parts": 80
        },
        {
          "last_ts": "2026-10-09T23:56:57.196+00:00",
          "first_ts": "2026-10-09T23:38:23.319+00:00",
          "session_id": "01a12308-16d4-7b32-8c56-c080e0f308f7",
          "tool_use_parts": 84
        },
        {
          "last_ts": "2026-10-10T00:06:54.315+00:00",
          "first_ts": "2026-10-09T23:58:13.706+00:00",
          "session_id": "01a12319-a27e-7fe2-b78d-458c9850efc8",
          "tool_use_parts": 50
        },
        {
          "last_ts": "2026-10-10T00:31:46.096+00:00",
          "first_ts": "2026-10-10T00:21:31.657+00:00",
          "session_id": "01a1232f-477f-7463-8b65-1c41196f6f7e",
          "tool_use_parts": 31
        },
        {
          "last_ts": "2026-10-10T00:40:06.05+00:00",
          "first_ts": "2026-10-10T00:32:38.753+00:00",
          "session_id": "01a12339-42ea-7242-824a-0b5166bd16ac",
          "tool_use_parts": 27
        },
        {
          "last_ts": "2026-10-10T00:55:31.824+00:00",
          "first_ts": "2026-10-10T00:45:48.724+00:00",
          "session_id": "01a12345-7d86-7bd0-b975-796fc56839ab",
          "tool_use_parts": 23
        },
        {
          "last_ts": "2026-10-10T01:25:30.587+00:00",
          "first_ts": "2026-10-10T01:04:10.205+00:00",
          "session_id": "01a12356-4811-7080-a02e-863980775e9c",
          "tool_use_parts": 64
        }
      ]
    },
    {
      "owner": "su-de5729a7-76d6-4498-8766-c084b2502a21",
      "witness": "2026-10-10 05:53:09.939+00",
      "custody_native": "01a12489-abcc-7ff3-b35a-a8a84157896e",
      "corrected_exact_native": {
        "parts": 98,
        "last_ts": "2026-10-10T06:56:10.945+00:00",
        "first_ts": "2026-10-10T06:39:26.726+00:00"
      },
      "witness_to_cutoff_tool_use_index": [
        {
          "last_ts": "2026-10-10T06:04:54.861+00:00",
          "first_ts": "2026-10-10T05:55:13.193+00:00",
          "session_id": "01a123f8-f7a5-7052-9826-46b5839fac59",
          "tool_use_parts": 20
        },
        {
          "last_ts": "2026-10-10T06:55:56.458+00:00",
          "first_ts": "2026-10-10T06:39:43.681+00:00",
          "session_id": "01a12489-abcc-7ff3-b35a-a8a84157896e",
          "tool_use_parts": 44
        }
      ]
    },
    {
      "owner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
      "witness": "2026-10-06 11:52:18.49+00",
      "custody_native": "01a12352-48ef-7a32-b5d6-001dc022af23",
      "corrected_exact_native": {
        "parts": 119,
        "last_ts": "2026-10-10T01:20:42.608+00:00",
        "first_ts": "2026-10-10T00:59:19.214+00:00"
      },
      "witness_to_cutoff_tool_use_index": [
        {
          "last_ts": "2026-10-06T11:53:12.283+00:00",
          "first_ts": "2026-10-06T11:52:36.944+00:00",
          "session_id": "01a110de-da18-77a1-ae59-266572a9581f",
          "tool_use_parts": 2
        },
        {
          "last_ts": "2026-10-06T12:22:36.791+00:00",
          "first_ts": "2026-10-06T11:54:45.118+00:00",
          "session_id": "01a11110-5644-7cd1-ae08-0fa1ab812d13",
          "tool_use_parts": 56
        },
        {
          "last_ts": "2026-10-06T12:43:34.417+00:00",
          "first_ts": "2026-10-06T12:24:05.854+00:00",
          "session_id": "01a1112b-5115-7990-a36b-c354420236b0",
          "tool_use_parts": 52
        },
        {
          "last_ts": "2026-10-06T13:12:32.367+00:00",
          "first_ts": "2026-10-06T12:44:51.946+00:00",
          "session_id": "01a1113e-65dd-7822-9033-cde625ea52e3",
          "tool_use_parts": 33
        },
        {
          "last_ts": "2026-10-06T13:34:56.224+00:00",
          "first_ts": "2026-10-06T13:13:48.77+00:00",
          "session_id": "01a11158-b6c7-7c23-8712-bc632b5004fa",
          "tool_use_parts": 54
        },
        {
          "last_ts": "2026-10-06T14:02:59.857+00:00",
          "first_ts": "2026-10-06T13:36:05.876+00:00",
          "session_id": "01a1116d-047a-71f2-a719-b43eb100ae49",
          "tool_use_parts": 42
        },
        {
          "last_ts": "2026-10-06T14:38:38.377+00:00",
          "first_ts": "2026-10-06T14:04:32.894+00:00",
          "session_id": "01a11187-7047-7ab3-9835-c40a05024551",
          "tool_use_parts": 68
        },
        {
          "last_ts": "2026-10-06T14:48:37.78+00:00",
          "first_ts": "2026-10-06T14:39:54.253+00:00",
          "session_id": "01a111a7-8cf1-7423-908a-2593a8fe6558",
          "tool_use_parts": 18
        },
        {
          "last_ts": "2026-10-06T17:17:19.526+00:00",
          "first_ts": "2026-10-06T16:47:05.707+00:00",
          "session_id": "01a1121c-4101-7c63-af3e-ef84388e3bbb",
          "tool_use_parts": 72
        },
        {
          "last_ts": "2026-10-09T21:25:33.081+00:00",
          "first_ts": "2026-10-09T20:41:54.124+00:00",
          "session_id": "01a12266-7409-79d3-9456-31ae1f03c7fb",
          "tool_use_parts": 132
        },
        {
          "last_ts": "2026-10-09T21:45:51.406+00:00",
          "first_ts": "2026-10-09T21:27:36.601+00:00",
          "session_id": "01a1228f-1738-79e1-8225-adb923521fa8",
          "tool_use_parts": 43
        },
        {
          "last_ts": "2026-10-09T22:13:28.592+00:00",
          "first_ts": "2026-10-09T21:47:10.846+00:00",
          "session_id": "01a122a1-681a-7a53-827e-cd1ccf56f52d",
          "tool_use_parts": 56
        },
        {
          "last_ts": "2026-10-09T22:38:31.314+00:00",
          "first_ts": "2026-10-09T22:24:59.649+00:00",
          "session_id": "01a122c4-d57d-7641-9c12-39444b89f809",
          "tool_use_parts": 46
        },
        {
          "last_ts": "2026-10-09T22:54:54.411+00:00",
          "first_ts": "2026-10-09T22:39:35.156+00:00",
          "session_id": "01a122d1-da5c-7d12-9751-8511c0773a32",
          "tool_use_parts": 42
        },
        {
          "last_ts": "2026-10-09T23:04:53.349+00:00",
          "first_ts": "2026-10-09T23:00:21.257+00:00",
          "session_id": "01a122e4-d6d7-7831-80ff-d7992b0a6bd2",
          "tool_use_parts": 18
        },
        {
          "last_ts": "2026-10-09T23:18:01.204+00:00",
          "first_ts": "2026-10-09T23:07:21.387+00:00",
          "session_id": "01a122eb-4a13-7623-af29-955febfe7554",
          "tool_use_parts": 34
        },
        {
          "last_ts": "2026-10-09T23:38:01.256+00:00",
          "first_ts": "2026-10-09T23:22:24.299+00:00",
          "session_id": "01a122f9-79ba-7103-822b-a12fb9cf4bc2",
          "tool_use_parts": 50
        },
        {
          "last_ts": "2026-10-10T00:02:14.805+00:00",
          "first_ts": "2026-10-09T23:38:46.456+00:00",
          "session_id": "01a12308-185e-7f41-bfec-9b7409dd18d3",
          "tool_use_parts": 62
        },
        {
          "last_ts": "2026-10-10T00:18:03.917+00:00",
          "first_ts": "2026-10-10T00:03:01.023+00:00",
          "session_id": "01a1231e-4587-78c2-aa03-27c4229be312",
          "tool_use_parts": 43
        },
        {
          "last_ts": "2026-10-10T00:36:12.606+00:00",
          "first_ts": "2026-10-10T00:18:52.219+00:00",
          "session_id": "01a1232c-bbfd-7201-ae9d-dabbbdc1be14",
          "tool_use_parts": 70
        },
        {
          "last_ts": "2026-10-10T00:59:03.14+00:00",
          "first_ts": "2026-10-10T00:42:44.002+00:00",
          "session_id": "01a12342-ad02-7c12-9677-7f6401fadfbc",
          "tool_use_parts": 71
        },
        {
          "last_ts": "2026-10-10T01:20:30.236+00:00",
          "first_ts": "2026-10-10T00:59:26.898+00:00",
          "session_id": "01a12352-48ef-7a32-b5d6-001dc022af23",
          "tool_use_parts": 54
        }
      ]
    },
    {
      "owner": "su-f6b6fcca-f4f9-484f-86ca-974378824a67",
      "witness": "2026-10-10 03:09:50.929+00",
      "custody_native": "01a123dd-2b69-75b2-8323-c43e797bca78",
      "corrected_exact_native": {
        "parts": 92,
        "last_ts": "2026-10-10T03:47:12.482+00:00",
        "first_ts": "2026-10-10T03:31:14.196+00:00"
      },
      "witness_to_cutoff_tool_use_index": [
        {
          "last_ts": "2026-10-10T03:11:18.404+00:00",
          "first_ts": "2026-10-10T03:10:03.263+00:00",
          "session_id": "01a122fa-d902-77e3-9bf0-4d450b2086f2",
          "tool_use_parts": 7
        },
        {
          "last_ts": "2026-10-10T03:27:20.285+00:00",
          "first_ts": "2026-10-10T03:12:10.369+00:00",
          "session_id": "01a123cb-c6da-7f62-9faf-3b74a8f833d9",
          "tool_use_parts": 40
        },
        {
          "last_ts": "2026-10-10T03:47:00.381+00:00",
          "first_ts": "2026-10-10T03:31:21.607+00:00",
          "session_id": "01a123dd-2b69-75b2-8323-c43e797bca78",
          "tool_use_parts": 40
        }
      ]
    },
    {
      "owner": "su-f6e9cbee-faee-465e-9281-2743f85a91ab",
      "witness": "2026-10-10 02:05:39.736+00",
      "custody_native": "01a123b8-2a5c-74e1-b654-b4b7df566a9e",
      "corrected_exact_native": {
        "parts": 89,
        "last_ts": "2026-10-10T03:07:37.249+00:00",
        "first_ts": "2026-10-10T02:50:36.246+00:00"
      },
      "witness_to_cutoff_tool_use_index": [
        {
          "last_ts": "2026-10-10T02:18:47.735+00:00",
          "first_ts": "2026-10-10T02:05:48.808+00:00",
          "session_id": "01a122a5-50fd-75c1-b5a5-a75c3e496e63",
          "tool_use_parts": 39
        },
        {
          "last_ts": "2026-10-10T03:07:20.856+00:00",
          "first_ts": "2026-10-10T02:50:40.76+00:00",
          "session_id": "01a123b8-2a5c-74e1-b654-b4b7df566a9e",
          "tool_use_parts": 39
        }
      ]
    },
    {
      "owner": "su-faf26552-0633-4081-a250-172c02f07c19",
      "witness": "2026-10-10 03:01:47.585+00",
      "custody_native": "01a12429-8730-7db0-b2bf-afcc88a8d58b",
      "corrected_exact_native": {
        "parts": 0,
        "last_ts": null,
        "first_ts": null
      },
      "witness_to_cutoff_tool_use_index": [
        {
          "last_ts": "2026-10-10T03:02:03.902+00:00",
          "first_ts": "2026-10-10T03:02:03.902+00:00",
          "session_id": "01a123a4-5fa4-7ce2-be09-ab21836e7b27",
          "tool_use_parts": 1
        },
        {
          "last_ts": "2026-10-10T03:19:25.856+00:00",
          "first_ts": "2026-10-10T03:02:56.23+00:00",
          "session_id": "01a123c3-011a-7f41-9501-be4014cfbaaf",
          "tool_use_parts": 40
        },
        {
          "last_ts": "2026-10-10T03:32:20.565+00:00",
          "first_ts": "2026-10-10T03:20:23.628+00:00",
          "session_id": "01a123d2-ee6c-7bc1-9a95-34572719bfe8",
          "tool_use_parts": 34
        },
        {
          "last_ts": "2026-10-10T04:00:30.947+00:00",
          "first_ts": "2026-10-10T03:33:59.08+00:00",
          "session_id": "01a123df-0540-7073-ab0f-160863c68c25",
          "tool_use_parts": 69
        },
        {
          "last_ts": "2026-10-10T04:28:02.102+00:00",
          "first_ts": "2026-10-10T04:10:51.992+00:00",
          "session_id": "01a123f8-ae4b-7790-8b2f-be40bab197e7",
          "tool_use_parts": 40
        },
        {
          "last_ts": "2026-10-10T04:53:53.618+00:00",
          "first_ts": "2026-10-10T04:29:34.185+00:00",
          "session_id": "01a12411-e413-7d30-ae42-79e0a4cd8440",
          "tool_use_parts": 46
        }
      ]
    }
  ],
  "summary": {
    "population": 21,
    "exactNativeWithParts": 19,
    "ownersWithIntervalToolUse": 21,
    "nativeToolUseIntervals": 217,
    "cutoffContinuityAccepted": 0,
    "outcomesJoined": 0
  },
  "limits": [
    "Counts provide indexed source coordinates only, not receipt completeness, cutoff continuity or pickup.",
    "Exact native id inherits mutable adv warning. Tool-use-only owner interval is a source subset, never exhaustive native census.",
    "No model/account/carry continuity verdict or recovery join."
  ]
}
