---
rel_path: "audits/parked-agent-resumption-2026-10-09/r13-cold53-seven-indexed-original-native-session-lineage-424d5.json"
updated_at: 1791992905578
_body: "content"
---

{
  "schemaVersion": "r13-cold53-seven-indexed-native-session-lineage-v1",
  "sql": "SELECT owner,source_kind,session_id,min(ts) AS first_tool,max(ts) AS last_tool,count(*) AS tool_parts FROM harness_shared.session_turn_parts WHERE workspace_id='default' AND owner IN ('su-298f8b56-c687-404f-99e1-d1c1e53baf0c','su-3077f62c-1a5d-4be6-896c-e75866032dcb','su-353a50d8-bcff-423e-9334-9498ed6ff4e9','su-684c584a-3351-49ee-a145-f657d7e42237','su-d759f7bc-0b18-43bd-8945-b839fa0e54c9','su-ec24b79e-fb5f-4056-847e-c1bd3edfec3a','su-fc5749a7-6632-4f73-9c99-8b475641e7e2') AND ts>='2026-10-01T00:00:00Z' AND ts<='2026-10-10T16:00:36.515Z' AND part_kind='tool_use' GROUP BY owner,source_kind,session_id ORDER BY owner,first_tool LIMIT 200",
  "result": {
    "mode": "query",
    "rowCount": 179,
    "truncated": false,
    "fields": [
      "owner",
      "source_kind",
      "session_id",
      "first_tool",
      "last_tool",
      "tool_parts"
    ],
    "elapsedMs": 217,
    "rows": [
      {
        "owner": "su-298f8b56-c687-404f-99e1-d1c1e53baf0c",
        "source_kind": "claude",
        "session_id": "01e06c2d-38f3-4242-855b-e3e26072becb",
        "first_tool": "2026-10-06 03:28:01.226+00",
        "last_tool": "2026-10-06 03:46:08.94+00",
        "tool_parts": "86"
      },
      {
        "owner": "su-298f8b56-c687-404f-99e1-d1c1e53baf0c",
        "source_kind": "claude",
        "session_id": "878c65f9-089c-4d53-9f9a-2019286830c0",
        "first_tool": "2026-10-06 03:46:36.665+00",
        "last_tool": "2026-10-06 04:36:22.186+00",
        "tool_parts": "89"
      },
      {
        "owner": "su-298f8b56-c687-404f-99e1-d1c1e53baf0c",
        "source_kind": "claude",
        "session_id": "91f7da2e-fced-4027-b7b2-fae6550de0c3",
        "first_tool": "2026-10-06 04:36:47.467+00",
        "last_tool": "2026-10-06 04:50:42.047+00",
        "tool_parts": "86"
      },
      {
        "owner": "su-298f8b56-c687-404f-99e1-d1c1e53baf0c",
        "source_kind": "claude",
        "session_id": "37d2d8c3-adbc-4e19-bc6f-1efbb07dfae2",
        "first_tool": "2026-10-06 04:51:50.147+00",
        "last_tool": "2026-10-06 05:03:26.971+00",
        "tool_parts": "60"
      },
      {
        "owner": "su-298f8b56-c687-404f-99e1-d1c1e53baf0c",
        "source_kind": "claude",
        "session_id": "054937ca-cea4-4aff-bbe4-8412f1b17980",
        "first_tool": "2026-10-06 05:03:48.041+00",
        "last_tool": "2026-10-06 05:29:11.568+00",
        "tool_parts": "76"
      },
      {
        "owner": "su-298f8b56-c687-404f-99e1-d1c1e53baf0c",
        "source_kind": "claude",
        "session_id": "9867293b-8f6b-4105-8335-0a3696cfa003",
        "first_tool": "2026-10-06 05:29:45.395+00",
        "last_tool": "2026-10-06 05:47:33.562+00",
        "tool_parts": "82"
      },
      {
        "owner": "su-298f8b56-c687-404f-99e1-d1c1e53baf0c",
        "source_kind": "claude",
        "session_id": "18dda0a8-0edc-480f-8f51-2b0063ddd979",
        "first_tool": "2026-10-06 05:47:58.779+00",
        "last_tool": "2026-10-06 06:28:58.168+00",
        "tool_parts": "91"
      },
      {
        "owner": "su-298f8b56-c687-404f-99e1-d1c1e53baf0c",
        "source_kind": "claude",
        "session_id": "95346ba0-2ee9-4fbc-8cb0-dcc57810c722",
        "first_tool": "2026-10-06 06:29:31.058+00",
        "last_tool": "2026-10-06 06:46:57.966+00",
        "tool_parts": "59"
      },
      {
        "owner": "su-298f8b56-c687-404f-99e1-d1c1e53baf0c",
        "source_kind": "claude",
        "session_id": "2d3f54f0-1900-4917-8130-c593cc191a8c",
        "first_tool": "2026-10-06 06:47:58.091+00",
        "last_tool": "2026-10-06 07:07:06.2+00",
        "tool_parts": "58"
      },
      {
        "owner": "su-298f8b56-c687-404f-99e1-d1c1e53baf0c",
        "source_kind": "claude",
        "session_id": "daa9a2aa-00d4-4ff3-92da-f89ecfa684df",
        "first_tool": "2026-10-06 07:07:36.986+00",
        "last_tool": "2026-10-06 07:53:35.048+00",
        "tool_parts": "65"
      },
      {
        "owner": "su-298f8b56-c687-404f-99e1-d1c1e53baf0c",
        "source_kind": "claude",
        "session_id": "33384674-41c2-4331-8b16-99a0430295e3",
        "first_tool": "2026-10-06 07:54:09.813+00",
        "last_tool": "2026-10-06 08:37:07.295+00",
        "tool_parts": "68"
      },
      {
        "owner": "su-298f8b56-c687-404f-99e1-d1c1e53baf0c",
        "source_kind": "claude",
        "session_id": "a6941db9-fe5e-4361-b757-b34da1be647c",
        "first_tool": "2026-10-06 08:37:49.771+00",
        "last_tool": "2026-10-06 09:41:17.739+00",
        "tool_parts": "55"
      },
      {
        "owner": "su-298f8b56-c687-404f-99e1-d1c1e53baf0c",
        "source_kind": "claude",
        "session_id": "a9569d58-a8f9-4bbb-bd5c-aca3514b6723",
        "first_tool": "2026-10-06 09:41:44.402+00",
        "last_tool": "2026-10-06 10:22:28.901+00",
        "tool_parts": "67"
      },
      {
        "owner": "su-298f8b56-c687-404f-99e1-d1c1e53baf0c",
        "source_kind": "claude",
        "session_id": "b0d5ab13-fe22-4129-a8fa-dbd42c2b6df7",
        "first_tool": "2026-10-06 10:22:53.578+00",
        "last_tool": "2026-10-06 10:51:27.383+00",
        "tool_parts": "53"
      },
      {
        "owner": "su-298f8b56-c687-404f-99e1-d1c1e53baf0c",
        "source_kind": "claude",
        "session_id": "796a87ee-47f9-43f2-83f6-3720b50dfaff",
        "first_tool": "2026-10-06 10:51:51.014+00",
        "last_tool": "2026-10-06 21:03:41.016+00",
        "tool_parts": "96"
      },
      {
        "owner": "su-298f8b56-c687-404f-99e1-d1c1e53baf0c",
        "source_kind": "claude",
        "session_id": "3746e1a1-8baf-4661-81d4-3538a00fab4e",
        "first_tool": "2026-10-06 21:04:17.608+00",
        "last_tool": "2026-10-06 21:19:52.526+00",
        "tool_parts": "55"
      },
      {
        "owner": "su-298f8b56-c687-404f-99e1-d1c1e53baf0c",
        "source_kind": "claude",
        "session_id": "88674d28-26cb-47e3-a374-3b2243017bc7",
        "first_tool": "2026-10-06 21:20:32.665+00",
        "last_tool": "2026-10-06 21:46:13.695+00",
        "tool_parts": "80"
      },
      {
        "owner": "su-298f8b56-c687-404f-99e1-d1c1e53baf0c",
        "source_kind": "claude",
        "session_id": "ec3796ef-041c-4cf9-9c30-36c041bbffdc",
        "first_tool": "2026-10-06 21:47:19.886+00",
        "last_tool": "2026-10-06 22:20:27.584+00",
        "tool_parts": "87"
      },
      {
        "owner": "su-298f8b56-c687-404f-99e1-d1c1e53baf0c",
        "source_kind": "claude",
        "session_id": "2567614e-70a5-4d9f-ac07-c2eccb0b47e8",
        "first_tool": "2026-10-06 22:22:19.579+00",
        "last_tool": "2026-10-06 23:12:08.256+00",
        "tool_parts": "89"
      },
      {
        "owner": "su-298f8b56-c687-404f-99e1-d1c1e53baf0c",
        "source_kind": "claude",
        "session_id": "43b6c1d6-0b55-42b4-8dd7-b87bbea87577",
        "first_tool": "2026-10-06 23:12:53.65+00",
        "last_tool": "2026-10-07 00:35:15.718+00",
        "tool_parts": "82"
      },
      {
        "owner": "su-298f8b56-c687-404f-99e1-d1c1e53baf0c",
        "source_kind": "codex",
        "session_id": "01a11413-6be8-7810-b073-954e2d954474",
        "first_tool": "2026-10-07 01:56:32.212+00",
        "last_tool": "2026-10-07 02:47:35.38+00",
        "tool_parts": "122"
      },
      {
        "owner": "su-3077f62c-1a5d-4be6-896c-e75866032dcb",
        "source_kind": "claude",
        "session_id": "129794b4-7f56-4591-b793-76986181727f",
        "first_tool": "2026-10-06 19:35:56.171+00",
        "last_tool": "2026-10-06 21:09:24.911+00",
        "tool_parts": "63"
      },
      {
        "owner": "su-3077f62c-1a5d-4be6-896c-e75866032dcb",
        "source_kind": "claude",
        "session_id": "7744b0a2-ea0b-4af1-9ca9-e2820b9bca57",
        "first_tool": "2026-10-06 21:10:09.51+00",
        "last_tool": "2026-10-06 21:37:41.052+00",
        "tool_parts": "83"
      },
      {
        "owner": "su-3077f62c-1a5d-4be6-896c-e75866032dcb",
        "source_kind": "claude",
        "session_id": "a52923a4-0d3a-4869-8070-39b2f22c4b03",
        "first_tool": "2026-10-06 21:38:18.432+00",
        "last_tool": "2026-10-06 21:56:42.157+00",
        "tool_parts": "83"
      },
      {
        "owner": "su-3077f62c-1a5d-4be6-896c-e75866032dcb",
        "source_kind": "claude",
        "session_id": "c6c73b7b-bda6-4d6d-94ae-6803ce888877",
        "first_tool": "2026-10-06 21:57:17.37+00",
        "last_tool": "2026-10-06 22:22:49.553+00",
        "tool_parts": "85"
      },
      {
        "owner": "su-3077f62c-1a5d-4be6-896c-e75866032dcb",
        "source_kind": "claude",
        "session_id": "cf785121-4de4-450b-969b-7abed3cf1402",
        "first_tool": "2026-10-06 22:23:47.397+00",
        "last_tool": "2026-10-06 23:26:44.41+00",
        "tool_parts": "106"
      },
      {
        "owner": "su-3077f62c-1a5d-4be6-896c-e75866032dcb",
        "source_kind": "claude",
        "session_id": "b293b5d8-c324-4c34-80e3-ca949b8a8dbb",
        "first_tool": "2026-10-06 23:28:52.522+00",
        "last_tool": "2026-10-07 00:07:59.614+00",
        "tool_parts": "25"
      },
      {
        "owner": "su-3077f62c-1a5d-4be6-896c-e75866032dcb",
        "source_kind": "codex",
        "session_id": "01a11414-f9a3-7500-9c20-741185f1e828",
        "first_tool": "2026-10-07 01:58:11.939+00",
        "last_tool": "2026-10-07 01:58:28.361+00",
        "tool_parts": "2"
      },
      {
        "owner": "su-353a50d8-bcff-423e-9334-9498ed6ff4e9",
        "source_kind": "codex",
        "session_id": "01a11893-b78d-7481-bba3-c2ea9cdcac87",
        "first_tool": "2026-10-07 22:55:12.567+00",
        "last_tool": "2026-10-07 23:33:59.783+00",
        "tool_parts": "63"
      },
      {
        "owner": "su-353a50d8-bcff-423e-9334-9498ed6ff4e9",
        "source_kind": "codex",
        "session_id": "01a118fb-a43e-75f3-92e8-4f29349fe487",
        "first_tool": "2026-10-08 00:48:38.831+00",
        "last_tool": "2026-10-08 01:39:32.062+00",
        "tool_parts": "73"
      },
      {
        "owner": "su-353a50d8-bcff-423e-9334-9498ed6ff4e9",
        "source_kind": "codex",
        "session_id": "01a1192a-a62c-7ff3-b98e-b65da8b93d39",
        "first_tool": "2026-10-08 01:40:09.033+00",
        "last_tool": "2026-10-08 02:33:05.285+00",
        "tool_parts": "109"
      },
      {
        "owner": "su-353a50d8-bcff-423e-9334-9498ed6ff4e9",
        "source_kind": "codex",
        "session_id": "01a1195b-ca8b-70d3-b6a1-d9578a9a7925",
        "first_tool": "2026-10-08 02:33:46.743+00",
        "last_tool": "2026-10-08 05:26:45.909+00",
        "tool_parts": "131"
      },
      {
        "owner": "su-353a50d8-bcff-423e-9334-9498ed6ff4e9",
        "source_kind": "codex",
        "session_id": "01a119fb-1342-7eb2-87d2-22cbc23f7526",
        "first_tool": "2026-10-08 05:27:49.184+00",
        "last_tool": "2026-10-08 12:01:16.298+00",
        "tool_parts": "73"
      },
      {
        "owner": "su-684c584a-3351-49ee-a145-f657d7e42237",
        "source_kind": "codex",
        "session_id": "01a112c8-84d5-7a21-9676-ebeeb9305891",
        "first_tool": "2026-10-06 19:55:03.161+00",
        "last_tool": "2026-10-06 20:27:44.18+00",
        "tool_parts": "68"
      },
      {
        "owner": "su-684c584a-3351-49ee-a145-f657d7e42237",
        "source_kind": "codex",
        "session_id": "01a112e6-f771-7040-9ff3-038bca30daab",
        "first_tool": "2026-10-06 20:28:48.017+00",
        "last_tool": "2026-10-06 22:09:40.284+00",
        "tool_parts": "95"
      },
      {
        "owner": "su-684c584a-3351-49ee-a145-f657d7e42237",
        "source_kind": "codex",
        "session_id": "01a11344-2c35-7812-a4f6-edca45c5c853",
        "first_tool": "2026-10-06 22:11:46.316+00",
        "last_tool": "2026-10-06 23:09:01.076+00",
        "tool_parts": "80"
      },
      {
        "owner": "su-684c584a-3351-49ee-a145-f657d7e42237",
        "source_kind": "codex",
        "session_id": "01a1137a-ac13-7002-908b-a0d03e11b8b8",
        "first_tool": "2026-10-06 23:10:03.28+00",
        "last_tool": "2026-10-06 23:46:13.853+00",
        "tool_parts": "71"
      },
      {
        "owner": "su-684c584a-3351-49ee-a145-f657d7e42237",
        "source_kind": "codex",
        "session_id": "01a1139c-9032-7023-91a3-4485e99080d8",
        "first_tool": "2026-10-06 23:47:00.617+00",
        "last_tool": "2026-10-07 03:06:33.066+00",
        "tool_parts": "84"
      },
      {
        "owner": "su-684c584a-3351-49ee-a145-f657d7e42237",
        "source_kind": "codex",
        "session_id": "01a11454-6e3a-7881-a182-668df21e8e3e",
        "first_tool": "2026-10-07 03:07:41.918+00",
        "last_tool": "2026-10-07 04:01:56.969+00",
        "tool_parts": "58"
      },
      {
        "owner": "su-684c584a-3351-49ee-a145-f657d7e42237",
        "source_kind": "codex",
        "session_id": "01a11486-aefe-75a1-a9de-65a0af46b551",
        "first_tool": "2026-10-07 04:02:44.8+00",
        "last_tool": "2026-10-07 05:05:55.172+00",
        "tool_parts": "70"
      },
      {
        "owner": "su-684c584a-3351-49ee-a145-f657d7e42237",
        "source_kind": "codex",
        "session_id": "01a114c1-9fdd-7f62-9edf-1d5e2db26760",
        "first_tool": "2026-10-07 05:08:14.047+00",
        "last_tool": "2026-10-07 05:43:58.193+00",
        "tool_parts": "58"
      },
      {
        "owner": "su-684c584a-3351-49ee-a145-f657d7e42237",
        "source_kind": "codex",
        "session_id": "01a114e4-1ba8-7fe2-ab89-b5147eb261e6",
        "first_tool": "2026-10-07 05:44:57.183+00",
        "last_tool": "2026-10-07 05:57:46.692+00",
        "tool_parts": "31"
      },
      {
        "owner": "su-684c584a-3351-49ee-a145-f657d7e42237",
        "source_kind": "codex",
        "session_id": "01a114f0-fdf2-7291-8207-c1bf24758830",
        "first_tool": "2026-10-07 05:58:42.447+00",
        "last_tool": "2026-10-07 06:18:51.373+00",
        "tool_parts": "39"
      },
      {
        "owner": "su-684c584a-3351-49ee-a145-f657d7e42237",
        "source_kind": "codex",
        "session_id": "01a11504-3da1-71b0-b642-4e542ed8bb4e",
        "first_tool": "2026-10-07 06:20:04.284+00",
        "last_tool": "2026-10-07 08:23:48.738+00",
        "tool_parts": "95"
      },
      {
        "owner": "su-684c584a-3351-49ee-a145-f657d7e42237",
        "source_kind": "codex",
        "session_id": "01a11576-baab-7f60-b1a1-bf2d5027dedf",
        "first_tool": "2026-10-07 08:25:08.573+00",
        "last_tool": "2026-10-07 09:52:41.172+00",
        "tool_parts": "92"
      },
      {
        "owner": "su-684c584a-3351-49ee-a145-f657d7e42237",
        "source_kind": "codex",
        "session_id": "01a115c8-2041-7d22-beb3-2aa562f73bc3",
        "first_tool": "2026-10-07 10:01:11.625+00",
        "last_tool": "2026-10-07 11:58:26.176+00",
        "tool_parts": "101"
      },
      {
        "owner": "su-684c584a-3351-49ee-a145-f657d7e42237",
        "source_kind": "codex",
        "session_id": "01a1163b-371b-7741-8598-bd77fd5474b8",
        "first_tool": "2026-10-07 11:59:46.152+00",
        "last_tool": "2026-10-07 14:41:50.447+00",
        "tool_parts": "87"
      },
      {
        "owner": "su-684c584a-3351-49ee-a145-f657d7e42237",
        "source_kind": "codex",
        "session_id": "01a116d2-2181-7771-bdf8-5efe6f4560c0",
        "first_tool": "2026-10-07 14:44:03.02+00",
        "last_tool": "2026-10-07 15:16:24.015+00",
        "tool_parts": "41"
      },
      {
        "owner": "su-684c584a-3351-49ee-a145-f657d7e42237",
        "source_kind": "codex",
        "session_id": "01a116f0-3e7b-7002-b8dc-5dbb0b6b7f28",
        "first_tool": "2026-10-07 15:17:45.29+00",
        "last_tool": "2026-10-07 18:58:44.617+00",
        "tool_parts": "68"
      },
      {
        "owner": "su-684c584a-3351-49ee-a145-f657d7e42237",
        "source_kind": "codex",
        "session_id": "01a117bb-b501-73d2-ad40-178d391da269",
        "first_tool": "2026-10-07 18:59:11.336+00",
        "last_tool": "2026-10-07 21:26:37.643+00",
        "tool_parts": "73"
      },
      {
        "owner": "su-684c584a-3351-49ee-a145-f657d7e42237",
        "source_kind": "codex",
        "session_id": "01a11901-a572-7c33-9ca5-1601c3bcd182",
        "first_tool": "2026-10-08 00:59:19.493+00",
        "last_tool": "2026-10-08 01:36:44.24+00",
        "tool_parts": "52"
      },
      {
        "owner": "su-684c584a-3351-49ee-a145-f657d7e42237",
        "source_kind": "codex",
        "session_id": "01a11928-5589-73b3-9ae8-fd06cfa25720",
        "first_tool": "2026-10-08 01:38:26.369+00",
        "last_tool": "2026-10-08 02:20:30.84+00",
        "tool_parts": "59"
      },
      {
        "owner": "su-684c584a-3351-49ee-a145-f657d7e42237",
        "source_kind": "codex",
        "session_id": "01a11950-1f4b-7022-bee9-41be8cb7ce10",
        "first_tool": "2026-10-08 02:21:05.412+00",
        "last_tool": "2026-10-08 04:06:45.258+00",
        "tool_parts": "75"
      },
      {
        "owner": "su-684c584a-3351-49ee-a145-f657d7e42237",
        "source_kind": "codex",
        "session_id": "01a119b1-c486-7a70-b706-bfcca25e8315",
        "first_tool": "2026-10-08 04:28:24.207+00",
        "last_tool": "2026-10-08 06:02:10.091+00",
        "tool_parts": "80"
      },
      {
        "owner": "su-684c584a-3351-49ee-a145-f657d7e42237",
        "source_kind": "codex",
        "session_id": "01a11a1b-5cb8-7153-ae77-b2d6ae91aac6",
        "first_tool": "2026-10-08 06:03:22.614+00",
        "last_tool": "2026-10-08 06:21:38.085+00",
        "tool_parts": "34"
      },
      {
        "owner": "su-684c584a-3351-49ee-a145-f657d7e42237",
        "source_kind": "codex",
        "session_id": "01a11a2d-38d4-73f2-be39-ba0b3a2764ef",
        "first_tool": "2026-10-08 06:22:53.725+00",
        "last_tool": "2026-10-08 06:56:20.611+00",
        "tool_parts": "58"
      },
      {
        "owner": "su-684c584a-3351-49ee-a145-f657d7e42237",
        "source_kind": "codex",
        "session_id": "01a11a4d-0ee6-7123-8570-3c86e4f166b9",
        "first_tool": "2026-10-08 06:57:21.417+00",
        "last_tool": "2026-10-08 07:29:03.011+00",
        "tool_parts": "44"
      },
      {
        "owner": "su-684c584a-3351-49ee-a145-f657d7e42237",
        "source_kind": "codex",
        "session_id": "01a11a6b-114f-78f1-8d3b-2e42388378f4",
        "first_tool": "2026-10-08 07:30:07.205+00",
        "last_tool": "2026-10-08 08:01:07.749+00",
        "tool_parts": "53"
      },
      {
        "owner": "su-684c584a-3351-49ee-a145-f657d7e42237",
        "source_kind": "codex",
        "session_id": "01a11a88-2e4f-7243-83b3-867f671f857e",
        "first_tool": "2026-10-08 08:04:25.108+00",
        "last_tool": "2026-10-08 08:38:00.478+00",
        "tool_parts": "53"
      },
      {
        "owner": "su-684c584a-3351-49ee-a145-f657d7e42237",
        "source_kind": "codex",
        "session_id": "01a11aaa-009b-7c90-964e-f9a7c0aa5d37",
        "first_tool": "2026-10-08 08:39:29.786+00",
        "last_tool": "2026-10-08 09:04:58.795+00",
        "tool_parts": "43"
      },
      {
        "owner": "su-684c584a-3351-49ee-a145-f657d7e42237",
        "source_kind": "codex",
        "session_id": "01a11ac2-c357-7573-a4ef-574440545602",
        "first_tool": "2026-10-08 10:08:52.788+00",
        "last_tool": "2026-10-08 10:30:50.987+00",
        "tool_parts": "38"
      },
      {
        "owner": "su-684c584a-3351-49ee-a145-f657d7e42237",
        "source_kind": "codex",
        "session_id": "01a11b11-4bb7-7352-8ef4-0cb47d2898da",
        "first_tool": "2026-10-08 10:31:35.192+00",
        "last_tool": "2026-10-08 10:56:18.483+00",
        "tool_parts": "52"
      },
      {
        "owner": "su-684c584a-3351-49ee-a145-f657d7e42237",
        "source_kind": "codex",
        "session_id": "01a11b28-6a60-71a2-afea-fc6dc6f6e924",
        "first_tool": "2026-10-08 10:57:22.329+00",
        "last_tool": "2026-10-08 11:35:13.71+00",
        "tool_parts": "74"
      },
      {
        "owner": "su-684c584a-3351-49ee-a145-f657d7e42237",
        "source_kind": "codex",
        "session_id": "01a11b4c-260c-7521-a687-dac1fd4389fd",
        "first_tool": "2026-10-08 11:36:33.959+00",
        "last_tool": "2026-10-08 12:17:35.203+00",
        "tool_parts": "77"
      },
      {
        "owner": "su-684c584a-3351-49ee-a145-f657d7e42237",
        "source_kind": "codex",
        "session_id": "01a11b73-1edd-7710-9330-a02acc60df96",
        "first_tool": "2026-10-08 12:18:55.183+00",
        "last_tool": "2026-10-08 12:37:44.077+00",
        "tool_parts": "38"
      },
      {
        "owner": "su-684c584a-3351-49ee-a145-f657d7e42237",
        "source_kind": "codex",
        "session_id": "01a11b85-4cdb-78f3-ac4e-ffd0f92095ec",
        "first_tool": "2026-10-08 12:58:02.928+00",
        "last_tool": "2026-10-08 13:20:56.4+00",
        "tool_parts": "46"
      },
      {
        "owner": "su-684c584a-3351-49ee-a145-f657d7e42237",
        "source_kind": "codex",
        "session_id": "01a11bac-e4b8-7b61-b04e-98df5e82455b",
        "first_tool": "2026-10-08 13:31:10.319+00",
        "last_tool": "2026-10-08 14:02:26.85+00",
        "tool_parts": "50"
      },
      {
        "owner": "su-684c584a-3351-49ee-a145-f657d7e42237",
        "source_kind": "codex",
        "session_id": "01a11bd2-d455-7aa3-8c89-ee87b34c94d1",
        "first_tool": "2026-10-08 14:14:06.837+00",
        "last_tool": "2026-10-08 14:54:50.324+00",
        "tool_parts": "75"
      },
      {
        "owner": "su-684c584a-3351-49ee-a145-f657d7e42237",
        "source_kind": "codex",
        "session_id": "01a11c03-2009-7d02-9c0e-ec2175c40c7d",
        "first_tool": "2026-10-08 14:56:24.712+00",
        "last_tool": "2026-10-08 15:19:32.227+00",
        "tool_parts": "49"
      },
      {
        "owner": "su-d759f7bc-0b18-43bd-8945-b839fa0e54c9",
        "source_kind": "codex",
        "session_id": "01a118ed-61ee-78a2-9e22-db49c5e4cd28",
        "first_tool": "2026-10-08 00:33:04.072+00",
        "last_tool": "2026-10-08 03:12:31.764+00",
        "tool_parts": "113"
      },
      {
        "owner": "su-d759f7bc-0b18-43bd-8945-b839fa0e54c9",
        "source_kind": "codex",
        "session_id": "01a11980-2b65-7b23-bb88-f26f635701c5",
        "first_tool": "2026-10-08 04:07:18.541+00",
        "last_tool": "2026-10-08 05:38:13.116+00",
        "tool_parts": "83"
      },
      {
        "owner": "su-d759f7bc-0b18-43bd-8945-b839fa0e54c9",
        "source_kind": "codex",
        "session_id": "01a11a05-deff-7bf2-83a1-236121a8ca64",
        "first_tool": "2026-10-08 05:39:28.518+00",
        "last_tool": "2026-10-08 06:05:25.491+00",
        "tool_parts": "49"
      },
      {
        "owner": "su-d759f7bc-0b18-43bd-8945-b839fa0e54c9",
        "source_kind": "codex",
        "session_id": "01a11a1e-3e84-72a2-a4d8-829b35bb8844",
        "first_tool": "2026-10-08 06:06:26.328+00",
        "last_tool": "2026-10-08 08:25:22.293+00",
        "tool_parts": "135"
      },
      {
        "owner": "su-d759f7bc-0b18-43bd-8945-b839fa0e54c9",
        "source_kind": "codex",
        "session_id": "01a11a9e-a447-7c33-bbe9-d86b5e222329",
        "first_tool": "2026-10-08 08:26:27.792+00",
        "last_tool": "2026-10-08 10:08:55.002+00",
        "tool_parts": "71"
      },
      {
        "owner": "su-d759f7bc-0b18-43bd-8945-b839fa0e54c9",
        "source_kind": "codex",
        "session_id": "01a11afd-47ea-72c1-b760-d8ce6d8197f1",
        "first_tool": "2026-10-08 10:09:42.363+00",
        "last_tool": "2026-10-08 12:14:37.068+00",
        "tool_parts": "155"
      },
      {
        "owner": "su-d759f7bc-0b18-43bd-8945-b839fa0e54c9",
        "source_kind": "codex",
        "session_id": "01a11b70-3f56-7330-80a9-571cbba9bb2e",
        "first_tool": "2026-10-08 12:15:20.878+00",
        "last_tool": "2026-10-08 14:32:44.478+00",
        "tool_parts": "141"
      },
      {
        "owner": "su-d759f7bc-0b18-43bd-8945-b839fa0e54c9",
        "source_kind": "codex",
        "session_id": "01a11bef-61ca-7922-95f7-16f43ab98342",
        "first_tool": "2026-10-08 14:34:33.891+00",
        "last_tool": "2026-10-08 15:17:56.166+00",
        "tool_parts": "61"
      },
      {
        "owner": "su-ec24b79e-fb5f-4056-847e-c1bd3edfec3a",
        "source_kind": "codex",
        "session_id": "01a11f68-4f60-7ca3-8909-7a99793ce586",
        "first_tool": "2026-10-09 06:45:02.178+00",
        "last_tool": "2026-10-09 07:05:56.647+00",
        "tool_parts": "64"
      },
      {
        "owner": "su-ec24b79e-fb5f-4056-847e-c1bd3edfec3a",
        "source_kind": "codex",
        "session_id": "01a11f7b-f621-7213-8786-f9c71671d39a",
        "first_tool": "2026-10-09 07:07:20.314+00",
        "last_tool": "2026-10-09 07:51:23.626+00",
        "tool_parts": "93"
      },
      {
        "owner": "su-ec24b79e-fb5f-4056-847e-c1bd3edfec3a",
        "source_kind": "codex",
        "session_id": "01a11fa5-603e-7e21-b091-51a69f60fcac",
        "first_tool": "2026-10-09 07:52:07.197+00",
        "last_tool": "2026-10-09 08:21:42.64+00",
        "tool_parts": "78"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0f6a1-9bdd-7142-88e4-12f088a4def7",
        "first_tool": "2026-10-01 08:43:44.018+00",
        "last_tool": "2026-10-01 08:46:27.164+00",
        "tool_parts": "12"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0f6a9-2333-7dd3-a4a9-3434afa55b5b",
        "first_tool": "2026-10-01 08:51:51.806+00",
        "last_tool": "2026-10-01 10:31:55.089+00",
        "tool_parts": "67"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0f705-e0fc-7ce3-a8f3-a26371c2c42f",
        "first_tool": "2026-10-01 10:33:18.826+00",
        "last_tool": "2026-10-01 11:57:43.725+00",
        "tool_parts": "86"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0f754-26bd-7f73-874f-3b491a334ea3",
        "first_tool": "2026-10-01 11:59:10.062+00",
        "last_tool": "2026-10-01 13:00:42.712+00",
        "tool_parts": "72"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0f78e-05e6-7cb0-8e1a-33d2a130b042",
        "first_tool": "2026-10-01 13:02:18.967+00",
        "last_tool": "2026-10-01 13:54:30.753+00",
        "tool_parts": "70"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0f7bf-85a5-74f2-99e2-ec656ac7d523",
        "first_tool": "2026-10-01 13:56:31.197+00",
        "last_tool": "2026-10-01 15:42:26.839+00",
        "tool_parts": "90"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0f822-783c-74c3-8595-7666d7381d41",
        "first_tool": "2026-10-01 15:44:24.565+00",
        "last_tool": "2026-10-01 17:07:28.226+00",
        "tool_parts": "93"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0f86f-ec7c-7e03-a2aa-3f5a179581fa",
        "first_tool": "2026-10-01 17:09:43.294+00",
        "last_tool": "2026-10-01 18:09:27.022+00",
        "tool_parts": "93"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0f8a8-e29b-7173-be3b-20fa7c6361c6",
        "first_tool": "2026-10-01 18:11:16.509+00",
        "last_tool": "2026-10-01 19:04:19.517+00",
        "tool_parts": "109"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0f8da-ac09-76b0-b438-23665be89e81",
        "first_tool": "2026-10-01 19:05:37.389+00",
        "last_tool": "2026-10-01 19:52:05.819+00",
        "tool_parts": "70"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0f906-8861-7283-813a-c659337c194c",
        "first_tool": "2026-10-01 19:53:26.936+00",
        "last_tool": "2026-10-01 20:44:29.462+00",
        "tool_parts": "78"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0f936-ac3b-77d1-9f09-5645dad2d59e",
        "first_tool": "2026-10-01 20:45:49.166+00",
        "last_tool": "2026-10-01 21:49:45.39+00",
        "tool_parts": "88"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0f972-2f12-74e0-91e5-5d8068c90c28",
        "first_tool": "2026-10-01 22:05:22.937+00",
        "last_tool": "2026-10-01 22:57:06.292+00",
        "tool_parts": "50"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0f9af-d01f-71e3-8c55-f897e6fa3db7",
        "first_tool": "2026-10-01 22:58:10.254+00",
        "last_tool": "2026-10-01 23:46:14.232+00",
        "tool_parts": "70"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0f9dc-e94b-79d0-bcba-2b13e0fd5894",
        "first_tool": "2026-10-01 23:48:06.663+00",
        "last_tool": "2026-10-02 00:24:18.117+00",
        "tool_parts": "66"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0fa00-0207-7022-9f0d-9a0ea4f64972",
        "first_tool": "2026-10-02 00:25:42.234+00",
        "last_tool": "2026-10-02 00:54:28.119+00",
        "tool_parts": "46"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0fa1b-2a73-7cf3-a7e4-bb775342690a",
        "first_tool": "2026-10-02 00:55:40.788+00",
        "last_tool": "2026-10-02 01:38:11.083+00",
        "tool_parts": "75"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0fa44-3561-74f3-9deb-6cf6e047e814",
        "first_tool": "2026-10-02 01:40:51.691+00",
        "last_tool": "2026-10-02 02:12:53.667+00",
        "tool_parts": "62"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0fa63-2472-7b31-8b76-de97041e154a",
        "first_tool": "2026-10-02 02:14:34.144+00",
        "last_tool": "2026-10-02 03:00:07.441+00",
        "tool_parts": "59"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0fa8e-7a3f-7d52-8846-75654677beef",
        "first_tool": "2026-10-02 03:01:37.422+00",
        "last_tool": "2026-10-02 03:46:13.047+00",
        "tool_parts": "65"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0fab8-78cd-78e2-9fc5-c74af2dc4b00",
        "first_tool": "2026-10-02 03:48:12.224+00",
        "last_tool": "2026-10-02 04:28:54.422+00",
        "tool_parts": "70"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0fadf-98e6-7663-bfbd-8c88d7c7bb06",
        "first_tool": "2026-10-02 04:30:17.456+00",
        "last_tool": "2026-10-02 05:07:09.289+00",
        "tool_parts": "58"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0fb02-d5c4-7771-87db-6e4b78aeb4b8",
        "first_tool": "2026-10-02 05:08:44.915+00",
        "last_tool": "2026-10-02 05:55:06.024+00",
        "tool_parts": "63"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0fb2e-6721-7193-9bbe-5ae99ce90df1",
        "first_tool": "2026-10-02 05:56:07.025+00",
        "last_tool": "2026-10-02 06:31:13.816+00",
        "tool_parts": "59"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0fb4f-97a9-7a03-8f07-327091409e8c",
        "first_tool": "2026-10-02 06:32:16.951+00",
        "last_tool": "2026-10-02 06:57:29.407+00",
        "tool_parts": "32"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0fb67-89fc-7bb3-bc91-21773dd0a6ff",
        "first_tool": "2026-10-02 06:58:27.122+00",
        "last_tool": "2026-10-02 07:36:25.771+00",
        "tool_parts": "51"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0fb8b-4437-7bc3-84a3-b0fde58b1657",
        "first_tool": "2026-10-02 07:37:30.186+00",
        "last_tool": "2026-10-02 08:06:02.926+00",
        "tool_parts": "42"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0fba6-4935-7b11-9b0a-b5a6a5a751ce",
        "first_tool": "2026-10-02 08:07:18.268+00",
        "last_tool": "2026-10-02 08:43:07.885+00",
        "tool_parts": "53"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0fbc8-3f00-72e3-8c1b-dc4b5e80d3d4",
        "first_tool": "2026-10-02 08:44:40.677+00",
        "last_tool": "2026-10-02 09:37:00.2+00",
        "tool_parts": "57"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0fbf9-f803-7711-bc51-024a226e1cc2",
        "first_tool": "2026-10-02 09:38:39.261+00",
        "last_tool": "2026-10-02 10:23:50.122+00",
        "tool_parts": "83"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0fc24-5ea8-7bb1-ab04-8b35c50ee89d",
        "first_tool": "2026-10-02 10:24:59.876+00",
        "last_tool": "2026-10-02 10:58:43.917+00",
        "tool_parts": "64"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0fc44-9efd-7b63-8a1b-543079cf7239",
        "first_tool": "2026-10-02 11:00:15.179+00",
        "last_tool": "2026-10-02 11:22:30.078+00",
        "tool_parts": "46"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0fc5a-74eb-7703-91b3-92d0c02f10a2",
        "first_tool": "2026-10-02 11:33:51.384+00",
        "last_tool": "2026-10-02 11:56:34.197+00",
        "tool_parts": "35"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0fc79-df1e-7323-9e8e-d4daba673a1f",
        "first_tool": "2026-10-02 11:58:22.888+00",
        "last_tool": "2026-10-02 12:29:29.53+00",
        "tool_parts": "55"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0fc97-8d84-76e1-8081-7d4f98550392",
        "first_tool": "2026-10-02 12:30:31.999+00",
        "last_tool": "2026-10-02 13:51:22.99+00",
        "tool_parts": "89"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0fce3-e0cf-7b82-8bfa-b340ed3705d8",
        "first_tool": "2026-10-02 13:53:54.053+00",
        "last_tool": "2026-10-02 15:17:28.497+00",
        "tool_parts": "82"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0fd31-d9ca-7042-a41a-10c4b393b74a",
        "first_tool": "2026-10-02 15:19:03.228+00",
        "last_tool": "2026-10-02 15:29:04.133+00",
        "tool_parts": "21"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0fd3d-9891-70a2-86cf-c36b95a63133",
        "first_tool": "2026-10-02 15:31:55.069+00",
        "last_tool": "2026-10-02 16:00:08.007+00",
        "tool_parts": "44"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0fd58-5bb3-72e3-baff-fff77d7edebd",
        "first_tool": "2026-10-02 16:01:12.305+00",
        "last_tool": "2026-10-02 16:29:35.271+00",
        "tool_parts": "47"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0fd73-6b29-71e0-9083-dcee39c257b3",
        "first_tool": "2026-10-02 16:30:43.943+00",
        "last_tool": "2026-10-02 17:12:31.215+00",
        "tool_parts": "68"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0fd9a-b235-7403-8467-37082c5ba944",
        "first_tool": "2026-10-02 17:13:47.537+00",
        "last_tool": "2026-10-02 17:56:05.352+00",
        "tool_parts": "70"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0fdc2-90e1-7fa2-a530-995a8fb5acce",
        "first_tool": "2026-10-02 17:56:56.235+00",
        "last_tool": "2026-10-02 18:33:00.724+00",
        "tool_parts": "64"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0fde4-78cc-7ee1-9c10-c5ed4e99c885",
        "first_tool": "2026-10-02 18:34:09.673+00",
        "last_tool": "2026-10-02 18:58:27.907+00",
        "tool_parts": "47"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0fdfb-af4f-7852-9eee-1c20ad58c1f3",
        "first_tool": "2026-10-02 18:59:30.666+00",
        "last_tool": "2026-10-02 19:29:21.985+00",
        "tool_parts": "51"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0fe17-e40f-73b2-beb0-c3dd6d7e13bc",
        "first_tool": "2026-10-02 19:30:29.716+00",
        "last_tool": "2026-10-02 19:58:00.594+00",
        "tool_parts": "45"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0fe32-3395-76b3-8862-01df150ff6a1",
        "first_tool": "2026-10-02 19:59:05.148+00",
        "last_tool": "2026-10-02 20:29:17.032+00",
        "tool_parts": "47"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0fe4e-e13b-7fe3-9582-75354da9a967",
        "first_tool": "2026-10-02 20:30:20.223+00",
        "last_tool": "2026-10-02 21:04:34.042+00",
        "tool_parts": "49"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0fe6f-1014-7413-ae4f-9a07c473e161",
        "first_tool": "2026-10-02 21:05:32.702+00",
        "last_tool": "2026-10-02 21:37:46.853+00",
        "tool_parts": "50"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0fe8d-892a-7590-a398-737e058a3e8e",
        "first_tool": "2026-10-02 21:38:51.333+00",
        "last_tool": "2026-10-02 22:15:59.124+00",
        "tool_parts": "58"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0feb0-7b0f-78d1-9034-3c4b853772db",
        "first_tool": "2026-10-02 22:16:45.806+00",
        "last_tool": "2026-10-02 22:48:11.003+00",
        "tool_parts": "59"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0fece-0566-7031-9f75-689aecbd3c4c",
        "first_tool": "2026-10-02 22:49:11.726+00",
        "last_tool": "2026-10-02 23:17:19.884+00",
        "tool_parts": "56"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0fee8-9ffe-7d71-8e6d-bbafa3b6a790",
        "first_tool": "2026-10-02 23:18:19.662+00",
        "last_tool": "2026-10-02 23:41:52.294+00",
        "tool_parts": "50"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0feff-21e4-73c3-b777-2b78a2fdb57d",
        "first_tool": "2026-10-02 23:43:11.679+00",
        "last_tool": "2026-10-02 23:57:05.284+00",
        "tool_parts": "30"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0ff0d-04e0-7822-9588-1b56c9d53d3f",
        "first_tool": "2026-10-02 23:58:23.598+00",
        "last_tool": "2026-10-03 00:19:25.263+00",
        "tool_parts": "37"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0ff21-7772-7340-ba8d-bf9073a9e2f3",
        "first_tool": "2026-10-03 00:20:33.465+00",
        "last_tool": "2026-10-03 00:40:28.329+00",
        "tool_parts": "32"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0ff35-02fc-77f0-a1c5-bf351fe1725e",
        "first_tool": "2026-10-03 00:41:42.658+00",
        "last_tool": "2026-10-03 01:02:33.87+00",
        "tool_parts": "35"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0ff48-f74e-7872-80fa-23d2fc69a00d",
        "first_tool": "2026-10-03 01:03:35.877+00",
        "last_tool": "2026-10-03 01:18:17.458+00",
        "tool_parts": "36"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0ff57-c88c-7de1-b697-dfbd4045ecfc",
        "first_tool": "2026-10-03 01:20:20.014+00",
        "last_tool": "2026-10-03 01:48:13.002+00",
        "tool_parts": "50"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0ff72-c4f8-7362-98ba-c2b312f2a301",
        "first_tool": "2026-10-03 01:49:31.627+00",
        "last_tool": "2026-10-03 02:17:13.389+00",
        "tool_parts": "41"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0ff8d-5562-77f2-b9d2-1af7c99dd0d7",
        "first_tool": "2026-10-03 02:18:17.612+00",
        "last_tool": "2026-10-03 02:38:43.185+00",
        "tool_parts": "42"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0ffa1-1821-7381-bfd1-16170574908e",
        "first_tool": "2026-10-03 02:40:11.68+00",
        "last_tool": "2026-10-03 02:58:42.142+00",
        "tool_parts": "34"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0ffb3-390f-7ff0-9296-84970e242475",
        "first_tool": "2026-10-03 03:00:01.565+00",
        "last_tool": "2026-10-03 03:15:10.776+00",
        "tool_parts": "27"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0ffc2-97bb-7282-88f9-7323745f8295",
        "first_tool": "2026-10-03 03:16:49.337+00",
        "last_tool": "2026-10-03 03:32:47.949+00",
        "tool_parts": "26"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0ffd2-98ba-73a2-b4bb-65a61e72381f",
        "first_tool": "2026-10-03 03:34:16.779+00",
        "last_tool": "2026-10-03 03:50:47.723+00",
        "tool_parts": "28"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0ffe3-1cc1-7203-8340-4d48beb8c2a3",
        "first_tool": "2026-10-03 03:52:16.012+00",
        "last_tool": "2026-10-03 04:12:36.065+00",
        "tool_parts": "34"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a0fff7-19dc-7cc0-a449-c952fe697a46",
        "first_tool": "2026-10-03 04:14:05.411+00",
        "last_tool": "2026-10-03 04:30:52.957+00",
        "tool_parts": "29"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a10007-968f-7b32-82d5-06dab66fb5fd",
        "first_tool": "2026-10-03 04:32:21.08+00",
        "last_tool": "2026-10-03 04:45:51.206+00",
        "tool_parts": "28"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a10015-702f-7510-98a5-4bb717e363df",
        "first_tool": "2026-10-03 04:47:15.128+00",
        "last_tool": "2026-10-03 05:02:35.949+00",
        "tool_parts": "30"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a10024-b6b7-7b63-9531-79487b0a1638",
        "first_tool": "2026-10-03 05:03:56.221+00",
        "last_tool": "2026-10-03 05:42:35.34+00",
        "tool_parts": "31"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a10049-4e2b-70a1-aaa2-68223ef9daa9",
        "first_tool": "2026-10-03 05:43:36.35+00",
        "last_tool": "2026-10-03 05:54:47.954+00",
        "tool_parts": "25"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a10054-72c1-7992-9b3e-d6d59c85dd0f",
        "first_tool": "2026-10-03 05:55:35.304+00",
        "last_tool": "2026-10-03 06:03:55.356+00",
        "tool_parts": "24"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a1005c-f3e6-7f02-b1c9-9662a3dd8bd6",
        "first_tool": "2026-10-03 06:05:11.662+00",
        "last_tool": "2026-10-03 06:26:27.233+00",
        "tool_parts": "37"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a10071-6f1d-70e3-a58e-60da50d50ba0",
        "first_tool": "2026-10-03 06:27:46.813+00",
        "last_tool": "2026-10-03 06:49:53.462+00",
        "tool_parts": "33"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a10086-e7e9-7d63-ad61-8867bf2a2322",
        "first_tool": "2026-10-03 06:51:12.553+00",
        "last_tool": "2026-10-03 07:06:50.516+00",
        "tool_parts": "30"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a10096-926e-7921-97c0-8108d85224d9",
        "first_tool": "2026-10-03 07:08:20.66+00",
        "last_tool": "2026-10-03 07:33:14.584+00",
        "tool_parts": "44"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a100ae-980a-7fb3-aeb7-e8a0363bb8ed",
        "first_tool": "2026-10-03 07:34:15.498+00",
        "last_tool": "2026-10-03 07:55:55.16+00",
        "tool_parts": "42"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a100c3-6643-70d0-8487-ccd4e4e1b9bb",
        "first_tool": "2026-10-03 07:56:56.889+00",
        "last_tool": "2026-10-03 08:12:16.991+00",
        "tool_parts": "26"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a100d2-74c8-7151-8740-feae99632413",
        "first_tool": "2026-10-03 08:13:17.371+00",
        "last_tool": "2026-10-03 08:27:59.577+00",
        "tool_parts": "26"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a100e0-c106-7a70-ae03-cd4af1d57d0c",
        "first_tool": "2026-10-03 08:29:13.91+00",
        "last_tool": "2026-10-03 08:49:34.919+00",
        "tool_parts": "51"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a100f4-92c0-78c0-bd9a-42ac7e0c6e14",
        "first_tool": "2026-10-03 08:50:25.892+00",
        "last_tool": "2026-10-03 09:05:47.161+00",
        "tool_parts": "34"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a10103-46a1-78b0-be30-d2d29d1ecf66",
        "first_tool": "2026-10-03 09:06:57.246+00",
        "last_tool": "2026-10-03 09:28:56.658+00",
        "tool_parts": "35"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a10118-c125-7b40-9e5b-0686c9efcf63",
        "first_tool": "2026-10-03 09:30:24.776+00",
        "last_tool": "2026-10-03 09:48:30.139+00",
        "tool_parts": "37"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a1012a-6f86-73c1-a876-c11cd660f69e",
        "first_tool": "2026-10-03 09:49:23.473+00",
        "last_tool": "2026-10-03 10:16:07.88+00",
        "tool_parts": "50"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a10143-c4a0-7f63-b702-6e6a53c7a416",
        "first_tool": "2026-10-03 10:17:25.385+00",
        "last_tool": "2026-10-03 10:56:35.527+00",
        "tool_parts": "92"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a10168-e806-7592-9eb8-12b669e5bd1c",
        "first_tool": "2026-10-03 10:57:26.481+00",
        "last_tool": "2026-10-03 11:16:31.353+00",
        "tool_parts": "33"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a1017b-0c50-7e30-8a79-b2f1c3ec41e8",
        "first_tool": "2026-10-03 11:17:46.102+00",
        "last_tool": "2026-10-03 11:36:03.679+00",
        "tool_parts": "37"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a1018c-f1fd-7193-9100-9f18431c7578",
        "first_tool": "2026-10-03 11:37:17.595+00",
        "last_tool": "2026-10-03 12:15:10.671+00",
        "tool_parts": "67"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a101b0-e3d6-78d3-95ba-0ab48ff75991",
        "first_tool": "2026-10-03 12:16:38.364+00",
        "last_tool": "2026-10-03 12:42:15.758+00",
        "tool_parts": "47"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a101c9-b648-7ee1-804e-d1e4fbe9bc97",
        "first_tool": "2026-10-03 12:43:38.153+00",
        "last_tool": "2026-10-03 13:08:51.839+00",
        "tool_parts": "31"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a101e2-239f-79f3-8097-acbdad99eb0e",
        "first_tool": "2026-10-03 13:10:36.932+00",
        "last_tool": "2026-10-03 13:35:43.835+00",
        "tool_parts": "38"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a101fc-7b3f-7440-bc42-8c3b90f14fe4",
        "first_tool": "2026-10-03 13:39:28.578+00",
        "last_tool": "2026-10-03 14:12:41.703+00",
        "tool_parts": "37"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a10c8f-c050-7ce0-8ce1-1950c54f6776",
        "first_tool": "2026-10-05 14:55:22.912+00",
        "last_tool": "2026-10-05 15:25:51.28+00",
        "tool_parts": "54"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a10cab-fcc6-70c3-92cc-365836019c54",
        "first_tool": "2026-10-05 15:26:58.187+00",
        "last_tool": "2026-10-05 15:45:02.712+00",
        "tool_parts": "28"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a10cbd-8965-7aa1-9286-93537928a28d",
        "first_tool": "2026-10-05 15:45:41.669+00",
        "last_tool": "2026-10-05 16:05:23.127+00",
        "tool_parts": "36"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a10cd0-3638-7ee0-a7bb-2b4858077220",
        "first_tool": "2026-10-05 16:05:48.815+00",
        "last_tool": "2026-10-05 16:22:24.776+00",
        "tool_parts": "33"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a10cdf-e470-7aa0-b859-0de1c0deef0f",
        "first_tool": "2026-10-05 16:22:53.49+00",
        "last_tool": "2026-10-05 16:39:27.348+00",
        "tool_parts": "30"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a10cef-8eba-7d71-bcf9-b848fba6c236",
        "first_tool": "2026-10-05 16:40:24.273+00",
        "last_tool": "2026-10-05 17:04:06.818+00",
        "tool_parts": "41"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a10d06-fb16-7d73-a8e6-43b8f6a2263d",
        "first_tool": "2026-10-05 17:06:26.194+00",
        "last_tool": "2026-10-05 17:19:59.675+00",
        "tool_parts": "26"
      },
      {
        "owner": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "source_kind": "codex",
        "session_id": "01a10d20-5de7-75b3-98c5-9d58d727e20b",
        "first_tool": "2026-10-05 17:33:19.333+00",
        "last_tool": "2026-10-05 17:46:34.256+00",
        "tool_parts": "27"
      }
    ]
  },
  "limits": [
    "Positive indexed tool-use rows identify preserved native sessions; absence does not establish that no other session or control existed."
  ]
}
