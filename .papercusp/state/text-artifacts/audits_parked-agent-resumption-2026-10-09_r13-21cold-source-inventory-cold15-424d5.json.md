---
rel_path: "audits/parked-agent-resumption-2026-10-09/r13-21cold-source-inventory-cold15-424d5.json"
updated_at: 1791877449640
_body: "content"
---

{
  "schemaVersion": "r13-21cold-source-inventory-v1",
  "observedAt": "2026-10-13T07:44:09.627Z",
  "cutoff": "2026-10-10T16:00:36.515Z",
  "cohortHash": "24ff6981fd54f120f96381dd93732ec9c1bfb2101d7eec063119bf85caeb163a",
  "sourceRefs": [
    "r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
    "r13-original116-route-custody-cold8-v5-424d5.json"
  ],
  "rows": [
    {
      "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
      "witness": "2026-10-09 16:47:39.148+00",
      "original_requests": [
        {
          "at": "2026-10-09 16:47:57.783+00",
          "id": "34777625",
          "status": "refused"
        },
        {
          "at": "2026-10-09 16:50:34.127+00",
          "id": "34778962",
          "status": "ok"
        },
        {
          "at": "2026-10-09 17:35:04.684+00",
          "id": "34800973",
          "status": "ok"
        },
        {
          "at": "2026-10-09 18:27:52.131+00",
          "id": "34826842",
          "status": "ok"
        },
        {
          "at": "2026-10-09 18:45:20.521+00",
          "id": "34836638",
          "status": "ok"
        },
        {
          "at": "2026-10-09 19:33:44.436+00",
          "id": "34863926",
          "status": "ok"
        },
        {
          "at": "2026-10-09 19:56:45.945+00",
          "id": "34875390",
          "status": "ok"
        },
        {
          "at": "2026-10-09 20:19:56.241+00",
          "id": "34887447",
          "status": "ok"
        },
        {
          "at": "2026-10-09 20:42:45.718+00",
          "id": "34902121",
          "status": "ok"
        },
        {
          "at": "2026-10-09 21:14:47.192+00",
          "id": "34920158",
          "status": "ok"
        },
        {
          "at": "2026-10-09 22:12:41.174+00",
          "id": "34952665",
          "status": "ok"
        },
        {
          "at": "2026-10-10 00:51:05.871+00",
          "id": "35031846",
          "status": "ok"
        },
        {
          "at": "2026-10-10 01:22:52.513+00",
          "id": "35047650",
          "status": "ok"
        },
        {
          "at": "2026-10-10 01:56:51.123+00",
          "id": "35064368",
          "status": "ok"
        },
        {
          "at": "2026-10-10 02:46:15.345+00",
          "id": "35086665",
          "status": "ok"
        },
        {
          "at": "2026-10-10 03:12:33.636+00",
          "id": "35099533",
          "status": "ok"
        },
        {
          "at": "2026-10-10 03:35:26.703+00",
          "id": "35109557",
          "status": "ok"
        },
        {
          "at": "2026-10-10 03:58:00.364+00",
          "id": "35120408",
          "status": "ok"
        }
      ],
      "original_adv": {
        "id": "39345",
        "agent": "codex",
        "parent": null,
        "ended_at": "2026-10-10 17:14:25.027017+00",
        "session_id": "01a123f6-6659-74e1-801e-ac4c020a7ca8",
        "started_at": "2026-10-10 03:58:33.631982+00",
        "launch_argv": [
          "psu",
          "--no-picker",
          "--agent=codex",
          "--headless",
          "--carry=cold",
          "--harness=papercusp",
          "--no-plan",
          "--model=gpt-6-luna:max",
          "--model-source=explicit",
          "--account=auto",
          "--fleet=nonp2p-bug-drain-luna-max-0930",
          "--auto",
          "--owner-id=su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5"
        ],
        "launched_at": null,
        "first_seen_at": "2026-10-10 00:36:09.013525+00",
        "coord_owner_id": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
        "identity_history": [
          {
            "keys": [
              "stack",
              "recordedAt",
              "stateRevision",
              "selectedIdentity",
              "specificationArtifact",
              "specificationRevision"
            ],
            "carry": null,
            "model": null,
            "account": null,
            "recordedAt": "2026-10-09T18:51:15.675153-04:00"
          }
        ]
      },
      "original_bootstrap": {
        "agent": "codex",
        "model": "gpt-6-luna:max",
        "account": null,
        "owner_id": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
        "carry_mode": null,
        "fleet_slug": "nonp2p-bug-drain-luna-max-0930",
        "launched_at": "1791592566876",
        "launched_by": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
        "account_mode": "default",
        "account_notice": "routing through the inference gateway (auto — it selects an available codex account).",
        "adv_session_id": "39345",
        "idempotency_key": "bootstrap-su:ba0e0b75-6075-4248-883e-5b7e843f85a9",
        "native_session_id": null
      },
      "exact_native_archive_metadata": null,
      "bounded_precutoff_native_index": {
        "last_ts": null,
        "first_ts": null,
        "last_part": null,
        "first_part": null,
        "retained_parts": 0
      }
    },
    {
      "owner": "su-1415d088-0af5-4299-a5df-8dbfc634335b",
      "witness": "2026-10-10 08:37:35.026+00",
      "original_requests": [
        {
          "at": "2026-10-10 08:46:34.597+00",
          "id": "35246962",
          "status": "ok"
        },
        {
          "at": "2026-10-10 09:09:15.586+00",
          "id": "35257928",
          "status": "ok"
        },
        {
          "at": "2026-10-10 09:35:13.222+00",
          "id": "35268060",
          "status": "ok"
        },
        {
          "at": "2026-10-10 10:11:28.014+00",
          "id": "35284056",
          "status": "ok"
        },
        {
          "at": "2026-10-10 11:04:58.432+00",
          "id": "35305755",
          "status": "ok"
        }
      ],
      "original_adv": {
        "id": "39663",
        "agent": "codex",
        "parent": null,
        "ended_at": "2026-10-10 21:06:47.469876+00",
        "session_id": "01a125c2-9d2b-7283-8c1b-f7e9ac0bedb2",
        "started_at": "2026-10-10 12:21:13.726875+00",
        "launch_argv": [
          "psu",
          "--no-picker",
          "--agent=codex",
          "--headless",
          "--carry=cold",
          "--harness=papercusp",
          "--no-plan",
          "--model=gpt-6-luna:max",
          "--model-source=explicit",
          "--account=auto",
          "--fleet=nonp2p-bug-drain-luna-max-0930",
          "--auto",
          "--owner-id=su-1415d088-0af5-4299-a5df-8dbfc634335b"
        ],
        "launched_at": null,
        "first_seen_at": "2026-10-10 12:21:10.859299+00",
        "coord_owner_id": "su-1415d088-0af5-4299-a5df-8dbfc634335b",
        "identity_history": null
      },
      "original_bootstrap": {
        "agent": "codex",
        "model": "gpt-6-luna:max",
        "account": null,
        "owner_id": "su-1415d088-0af5-4299-a5df-8dbfc634335b",
        "carry_mode": null,
        "fleet_slug": "nonp2p-bug-drain-luna-max-0930",
        "launched_at": "1791634870809",
        "launched_by": "su-1415d088-0af5-4299-a5df-8dbfc634335b",
        "account_mode": "default",
        "account_notice": "routing through the inference gateway (auto — it selects an available codex account).",
        "adv_session_id": "39663",
        "idempotency_key": "bootstrap-su:74aa702c-25c2-4f6b-a5be-ebbf6ad5ba6c",
        "native_session_id": null
      },
      "exact_native_archive_metadata": null,
      "bounded_precutoff_native_index": {
        "last_ts": null,
        "first_ts": null,
        "last_part": null,
        "first_part": null,
        "retained_parts": 0
      }
    },
    {
      "owner": "su-3067d842-6f5a-41ad-bada-9a47df0ea9a6",
      "witness": "2026-10-09 23:49:17.159+00",
      "original_requests": [
        {
          "at": "2026-10-09 23:50:46.285+00",
          "id": "35002303",
          "status": "ok"
        },
        {
          "at": "2026-10-10 00:44:31.503+00",
          "id": "35028001",
          "status": "ok"
        },
        {
          "at": "2026-10-10 01:00:19.687+00",
          "id": "35036424",
          "status": "ok"
        },
        {
          "at": "2026-10-10 01:20:47.699+00",
          "id": "35046578",
          "status": "ok"
        }
      ],
      "original_adv": {
        "id": "39262",
        "agent": "codex",
        "parent": null,
        "ended_at": "2026-10-10 17:15:44.660519+00",
        "session_id": "01a12353-79f3-73f3-aa5d-89fd463e5c5b",
        "started_at": "2026-10-10 01:00:35.872525+00",
        "launch_argv": [
          "psu",
          "--no-picker",
          "--agent=codex",
          "--headless",
          "--carry=cold",
          "--harness=papercusp",
          "--no-plan",
          "--model=gpt-6-luna:max",
          "--model-source=explicit",
          "--account=auto",
          "--fleet=nonp2p-bug-drain-luna-max-0930",
          "--auto",
          "--owner-id=su-3067d842-6f5a-41ad-bada-9a47df0ea9a6"
        ],
        "launched_at": null,
        "first_seen_at": "2026-10-09 22:46:57.293281+00",
        "coord_owner_id": "su-3067d842-6f5a-41ad-bada-9a47df0ea9a6",
        "identity_history": null
      },
      "original_bootstrap": {
        "agent": "codex",
        "model": "gpt-6-luna:max",
        "account": null,
        "owner_id": "su-3067d842-6f5a-41ad-bada-9a47df0ea9a6",
        "carry_mode": null,
        "fleet_slug": "nonp2p-bug-drain-luna-max-0930",
        "launched_at": "1791586016687",
        "launched_by": "su-3067d842-6f5a-41ad-bada-9a47df0ea9a6",
        "account_mode": "default",
        "account_notice": "routing through the inference gateway (auto — it selects an available codex account).",
        "adv_session_id": "39262",
        "idempotency_key": "bootstrap-su:7d26c8a4-075b-48ad-a1cd-002832b725f1",
        "native_session_id": null
      },
      "exact_native_archive_metadata": null,
      "bounded_precutoff_native_index": {
        "last_ts": null,
        "first_ts": null,
        "last_part": null,
        "first_part": null,
        "retained_parts": 0
      }
    },
    {
      "owner": "su-312c90f2-a3bd-4c92-ac4e-4eae40ae2647",
      "witness": "2026-10-09 23:12:56.031+00",
      "original_requests": [
        {
          "at": "2026-10-09 23:14:36.105+00",
          "id": "34983377",
          "status": "ok"
        },
        {
          "at": "2026-10-10 01:07:20.043+00",
          "id": "35040409",
          "status": "ok"
        },
        {
          "at": "2026-10-10 01:55:54.773+00",
          "id": "35063976",
          "status": "ok"
        },
        {
          "at": "2026-10-10 02:53:27.727+00",
          "id": "35089988",
          "status": "ok"
        },
        {
          "at": "2026-10-10 03:35:15.464+00",
          "id": "35109461",
          "status": "ok"
        },
        {
          "at": "2026-10-10 03:56:25.068+00",
          "id": "35119644",
          "status": "ok"
        },
        {
          "at": "2026-10-10 08:28:44.194+00",
          "id": "35239534",
          "status": "ok"
        }
      ],
      "original_adv": {
        "id": "39565",
        "agent": "codex",
        "parent": null,
        "ended_at": "2026-10-10 22:10:04.542872+00",
        "session_id": "01a124df-4dc0-7741-97a6-73362938b29d",
        "started_at": "2026-10-10 08:12:57.374777+00",
        "launch_argv": [
          "psu",
          "--no-picker",
          "--agent=codex",
          "--headless",
          "--carry=cold",
          "--harness=papercusp",
          "--no-plan",
          "--model=gpt-6-luna:max",
          "--model-source=explicit",
          "--account=auto",
          "--fleet=nonp2p-bug-drain-luna-max-0930",
          "--auto",
          "--owner-id=su-312c90f2-a3bd-4c92-ac4e-4eae40ae2647"
        ],
        "launched_at": null,
        "first_seen_at": "2026-10-10 08:12:49.941531+00",
        "coord_owner_id": "su-312c90f2-a3bd-4c92-ac4e-4eae40ae2647",
        "identity_history": null
      },
      "original_bootstrap": {
        "agent": "codex",
        "model": "gpt-6-luna:max",
        "account": null,
        "owner_id": "su-312c90f2-a3bd-4c92-ac4e-4eae40ae2647",
        "carry_mode": null,
        "fleet_slug": "nonp2p-bug-drain-luna-max-0930",
        "launched_at": "1791619969908",
        "launched_by": "su-312c90f2-a3bd-4c92-ac4e-4eae40ae2647",
        "account_mode": "default",
        "account_notice": "routing through the inference gateway (auto — it selects an available codex account).",
        "adv_session_id": "39565",
        "idempotency_key": "bootstrap-su:b2617d8e-2073-441f-ad86-6ff95793db0e",
        "native_session_id": null
      },
      "exact_native_archive_metadata": null,
      "bounded_precutoff_native_index": {
        "last_ts": null,
        "first_ts": null,
        "last_part": null,
        "first_part": null,
        "retained_parts": 0
      }
    },
    {
      "owner": "su-449b83a8-a709-43af-9681-768dc6ac744a",
      "witness": "2026-10-09 23:15:12.114+00",
      "original_requests": [
        {
          "at": "2026-10-10 00:30:08.391+00",
          "id": "35020841",
          "status": "ok"
        },
        {
          "at": "2026-10-10 00:48:31.351+00",
          "id": "35030421",
          "status": "ok"
        },
        {
          "at": "2026-10-10 01:05:29.039+00",
          "id": "35039357",
          "status": "ok"
        },
        {
          "at": "2026-10-10 01:11:55.169+00",
          "id": "35042969",
          "status": "ok"
        }
      ],
      "original_adv": {
        "id": "39333",
        "agent": "codex",
        "parent": null,
        "ended_at": "2026-10-10 17:15:25.913327+00",
        "session_id": "01a12358-40b3-7071-afa8-73e105e0851b",
        "started_at": "2026-10-10 01:05:48.860843+00",
        "launch_argv": [
          "psu",
          "--no-picker",
          "--agent=codex",
          "--headless",
          "--carry=cold",
          "--harness=papercusp",
          "--no-plan",
          "--model=gpt-6-luna:max",
          "--model-source=explicit",
          "--account=auto",
          "--fleet=nonp2p-bug-drain-luna-max-0930",
          "--auto",
          "--owner-id=su-449b83a8-a709-43af-9681-768dc6ac744a"
        ],
        "launched_at": null,
        "first_seen_at": "2026-10-10 00:14:22.355854+00",
        "coord_owner_id": "su-449b83a8-a709-43af-9681-768dc6ac744a",
        "identity_history": null
      },
      "original_bootstrap": {
        "agent": "codex",
        "model": "gpt-6-luna:max",
        "account": null,
        "owner_id": "su-449b83a8-a709-43af-9681-768dc6ac744a",
        "carry_mode": null,
        "fleet_slug": "nonp2p-bug-drain-luna-max-0930",
        "launched_at": "1791591262139",
        "launched_by": "su-449b83a8-a709-43af-9681-768dc6ac744a",
        "account_mode": "default",
        "account_notice": "routing through the inference gateway (auto — it selects an available codex account).",
        "adv_session_id": "39333",
        "idempotency_key": "bootstrap-su:47e64265-fa75-4a99-856e-0064d19237c8",
        "native_session_id": null
      },
      "exact_native_archive_metadata": null,
      "bounded_precutoff_native_index": {
        "last_ts": null,
        "first_ts": null,
        "last_part": null,
        "first_part": null,
        "retained_parts": 0
      }
    },
    {
      "owner": "su-4adf5ebc-6443-4c3c-b704-162275765ff1",
      "witness": "2026-10-10 09:57:44.521+00",
      "original_requests": [
        {
          "at": "2026-10-10 09:58:13.763+00",
          "id": "35277559",
          "status": "ok"
        },
        {
          "at": "2026-10-10 10:15:59.881+00",
          "id": "35286001",
          "status": "ok"
        },
        {
          "at": "2026-10-10 12:22:12.453+00",
          "id": "35342589",
          "status": "ok"
        }
      ],
      "original_adv": {
        "id": "39654",
        "agent": "codex",
        "parent": null,
        "ended_at": "2026-10-10 22:10:04.167494+00",
        "session_id": "01a125b4-15cc-7d41-8499-3be49aaffbe1",
        "started_at": "2026-10-10 12:05:21.609027+00",
        "launch_argv": [
          "psu",
          "--no-picker",
          "--agent=codex",
          "--headless",
          "--carry=cold",
          "--harness=papercusp",
          "--no-plan",
          "--model=gpt-6-luna:max",
          "--model-source=explicit",
          "--account=auto",
          "--fleet=nonp2p-bug-drain-luna-max-0930",
          "--auto",
          "--owner-id=su-4adf5ebc-6443-4c3c-b704-162275765ff1"
        ],
        "launched_at": null,
        "first_seen_at": "2026-10-10 12:05:15.600297+00",
        "coord_owner_id": "su-4adf5ebc-6443-4c3c-b704-162275765ff1",
        "identity_history": null
      },
      "original_bootstrap": {
        "agent": "codex",
        "model": "gpt-6-luna:max",
        "account": null,
        "owner_id": "su-4adf5ebc-6443-4c3c-b704-162275765ff1",
        "carry_mode": null,
        "fleet_slug": "nonp2p-bug-drain-luna-max-0930",
        "launched_at": "1791633915492",
        "launched_by": "su-4adf5ebc-6443-4c3c-b704-162275765ff1",
        "account_mode": "default",
        "account_notice": "routing through the inference gateway (auto — it selects an available codex account).",
        "adv_session_id": "39654",
        "idempotency_key": "bootstrap-su:f32c5143-cc34-43d3-ace9-b286bdd645ce",
        "native_session_id": null
      },
      "exact_native_archive_metadata": null,
      "bounded_precutoff_native_index": {
        "last_ts": null,
        "first_ts": null,
        "last_part": null,
        "first_part": null,
        "retained_parts": 0
      }
    },
    {
      "owner": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
      "witness": "2026-10-09 18:25:44.655+00",
      "original_requests": [
        {
          "at": "2026-10-09 18:26:41.363+00",
          "id": "34826106",
          "status": "ok"
        },
        {
          "at": "2026-10-09 18:45:26.137+00",
          "id": "34836688",
          "status": "ok"
        },
        {
          "at": "2026-10-09 19:18:30.408+00",
          "id": "34855337",
          "status": "ok"
        },
        {
          "at": "2026-10-09 20:11:09.289+00",
          "id": "34882439",
          "status": "ok"
        },
        {
          "at": "2026-10-09 20:35:14.727+00",
          "id": "34897845",
          "status": "ok"
        },
        {
          "at": "2026-10-09 21:22:57.517+00",
          "id": "34924375",
          "status": "ok"
        },
        {
          "at": "2026-10-09 21:46:41.23+00",
          "id": "34938104",
          "status": "ok"
        },
        {
          "at": "2026-10-09 22:34:27.609+00",
          "id": "34962872",
          "status": "ok"
        },
        {
          "at": "2026-10-09 23:01:46.587+00",
          "id": "34975894",
          "status": "ok"
        },
        {
          "at": "2026-10-09 23:25:28.951+00",
          "id": "34988920",
          "status": "ok"
        },
        {
          "at": "2026-10-09 23:39:39.798+00",
          "id": "34996602",
          "status": "ok"
        },
        {
          "at": "2026-10-09 23:59:04.536+00",
          "id": "35006152",
          "status": "ok"
        },
        {
          "at": "2026-10-10 00:18:58.68+00",
          "id": "35015509",
          "status": "ok"
        },
        {
          "at": "2026-10-10 00:30:23.414+00",
          "id": "35020967",
          "status": "ok"
        },
        {
          "at": "2026-10-10 00:49:27.851+00",
          "id": "35030923",
          "status": "ok"
        },
        {
          "at": "2026-10-10 01:45:43.638+00",
          "id": "35059682",
          "status": "ok"
        },
        {
          "at": "2026-10-10 01:46:30.984+00",
          "id": "35060092",
          "status": "ok"
        }
      ],
      "original_adv": {
        "id": "39228",
        "agent": "codex",
        "parent": null,
        "ended_at": "2026-10-10 17:15:22.116438+00",
        "session_id": "01a12368-8531-7902-b76a-f5453e0f8474",
        "started_at": "2026-10-10 01:23:35.112911+00",
        "launch_argv": [
          "psu",
          "--no-picker",
          "--agent=codex",
          "--headless",
          "--carry=cold",
          "--harness=papercusp",
          "--no-plan",
          "--model=gpt-6-luna:max",
          "--model-source=explicit",
          "--account=auto",
          "--fleet=nonp2p-bug-drain-luna-max-0930",
          "--auto",
          "--owner-id=su-77348e3d-80ac-42d8-b4e7-bdce9684a72a"
        ],
        "launched_at": null,
        "first_seen_at": "2026-10-09 22:23:32.103065+00",
        "coord_owner_id": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
        "identity_history": null
      },
      "original_bootstrap": {
        "agent": "codex",
        "model": "gpt-6-luna:max",
        "account": null,
        "owner_id": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
        "carry_mode": null,
        "fleet_slug": "nonp2p-bug-drain-luna-max-0930",
        "launched_at": "1791584612041",
        "launched_by": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
        "account_mode": "default",
        "account_notice": "routing through the inference gateway (auto — it selects an available codex account).",
        "adv_session_id": "39228",
        "idempotency_key": "bootstrap-su:0ffd77e2-732d-4595-92a1-9d1055447459",
        "native_session_id": null
      },
      "exact_native_archive_metadata": null,
      "bounded_precutoff_native_index": {
        "last_ts": null,
        "first_ts": null,
        "last_part": null,
        "first_part": null,
        "retained_parts": 0
      }
    },
    {
      "owner": "su-82c46308-5eb9-4237-9d2d-950d322576c4",
      "witness": "2026-10-09 20:16:13.818+00",
      "original_requests": [
        {
          "at": "2026-10-09 20:18:38.222+00",
          "id": "34886663",
          "status": "ok"
        },
        {
          "at": "2026-10-09 22:10:59.546+00",
          "id": "34951697",
          "status": "ok"
        },
        {
          "at": "2026-10-09 22:44:15.679+00",
          "id": "34967591",
          "status": "ok"
        },
        {
          "at": "2026-10-09 23:07:33.987+00",
          "id": "34979247",
          "status": "ok"
        },
        {
          "at": "2026-10-10 00:24:41.364+00",
          "id": "35018210",
          "status": "ok"
        },
        {
          "at": "2026-10-10 01:03:17.598+00",
          "id": "35038308",
          "status": "ok"
        }
      ],
      "original_adv": {
        "id": "39232",
        "agent": "codex",
        "parent": null,
        "ended_at": "2026-10-10 17:15:32.805918+00",
        "session_id": "01a12356-659d-7871-a5dd-c4a744655ff4",
        "started_at": "2026-10-10 01:03:47.353719+00",
        "launch_argv": [
          "psu",
          "--no-picker",
          "--agent=codex",
          "--headless",
          "--carry=cold",
          "--harness=papercusp",
          "--no-plan",
          "--model=gpt-6-luna:max",
          "--model-source=explicit",
          "--account=auto",
          "--fleet=nonp2p-bug-drain-luna-max-0930",
          "--auto",
          "--owner-id=su-82c46308-5eb9-4237-9d2d-950d322576c4"
        ],
        "launched_at": null,
        "first_seen_at": "2026-10-09 22:24:44.155486+00",
        "coord_owner_id": "su-82c46308-5eb9-4237-9d2d-950d322576c4",
        "identity_history": null
      },
      "original_bootstrap": {
        "agent": "codex",
        "model": "gpt-6-luna:max",
        "account": null,
        "owner_id": "su-82c46308-5eb9-4237-9d2d-950d322576c4",
        "carry_mode": null,
        "fleet_slug": "nonp2p-bug-drain-luna-max-0930",
        "launched_at": "1791584684097",
        "launched_by": "su-82c46308-5eb9-4237-9d2d-950d322576c4",
        "account_mode": "default",
        "account_notice": "routing through the inference gateway (auto — it selects an available codex account).",
        "adv_session_id": "39232",
        "idempotency_key": "bootstrap-su:0106289f-29b9-4c93-b6c9-4b5bf4daf265",
        "native_session_id": null
      },
      "exact_native_archive_metadata": null,
      "bounded_precutoff_native_index": {
        "last_ts": null,
        "first_ts": null,
        "last_part": null,
        "first_part": null,
        "retained_parts": 0
      }
    },
    {
      "owner": "su-8d2cb6cc-8f27-4a25-8541-b00927471b94",
      "witness": "2026-10-10 03:26:03.2+00",
      "original_requests": [
        {
          "at": "2026-10-10 04:28:04.495+00",
          "id": "35133707",
          "status": "ok"
        }
      ],
      "original_adv": {
        "id": "39463",
        "agent": "codex",
        "parent": null,
        "ended_at": "2026-10-10 22:10:04.41753+00",
        "session_id": "01a123fe-6eda-7640-9dc5-7f91366ee84e",
        "started_at": "2026-10-10 04:07:19.666494+00",
        "launch_argv": [
          "psu",
          "--no-picker",
          "--agent=codex",
          "--headless",
          "--carry=cold",
          "--harness=papercusp",
          "--no-plan",
          "--model=gpt-6-luna:max",
          "--model-source=explicit",
          "--account=auto",
          "--fleet=nonp2p-bug-drain-luna-max-0930",
          "--auto",
          "--owner-id=su-8d2cb6cc-8f27-4a25-8541-b00927471b94"
        ],
        "launched_at": null,
        "first_seen_at": "2026-10-10 04:07:16.642622+00",
        "coord_owner_id": "su-8d2cb6cc-8f27-4a25-8541-b00927471b94",
        "identity_history": null
      },
      "original_bootstrap": {
        "agent": "codex",
        "model": "gpt-6-luna:max",
        "account": null,
        "owner_id": "su-8d2cb6cc-8f27-4a25-8541-b00927471b94",
        "carry_mode": null,
        "fleet_slug": "nonp2p-bug-drain-luna-max-0930",
        "launched_at": "1791605236607",
        "launched_by": "su-8d2cb6cc-8f27-4a25-8541-b00927471b94",
        "account_mode": "default",
        "account_notice": "routing through the inference gateway (auto — it selects an available codex account).",
        "adv_session_id": "39463",
        "idempotency_key": "bootstrap-su:39b81845-fe34-4b07-870b-70daf6327119",
        "native_session_id": null
      },
      "exact_native_archive_metadata": null,
      "bounded_precutoff_native_index": {
        "last_ts": null,
        "first_ts": null,
        "last_part": null,
        "first_part": null,
        "retained_parts": 0
      }
    },
    {
      "owner": "su-960a52e7-9b11-42ac-8fe9-7e5e7e0da441",
      "witness": "2026-10-10 00:17:12.298+00",
      "original_requests": [
        {
          "at": "2026-10-10 00:17:31.86+00",
          "id": "35014709",
          "status": "ok"
        },
        {
          "at": "2026-10-10 00:35:12.21+00",
          "id": "35023582",
          "status": "ok"
        },
        {
          "at": "2026-10-10 01:17:56.139+00",
          "id": "35045222",
          "status": "ok"
        }
      ],
      "original_adv": {
        "id": "39271",
        "agent": "codex",
        "parent": null,
        "ended_at": "2026-10-10 17:15:40.88161+00",
        "session_id": "01a12354-76df-7230-8a3e-7b5bc95a62ef",
        "started_at": "2026-10-10 01:01:40.67385+00",
        "launch_argv": [
          "psu",
          "--no-picker",
          "--agent=codex",
          "--headless",
          "--carry=cold",
          "--harness=papercusp",
          "--no-plan",
          "--model=gpt-6-luna:max",
          "--model-source=explicit",
          "--account=auto",
          "--fleet=nonp2p-bug-drain-luna-max-0930",
          "--auto",
          "--owner-id=su-960a52e7-9b11-42ac-8fe9-7e5e7e0da441"
        ],
        "launched_at": null,
        "first_seen_at": "2026-10-09 23:01:24.06244+00",
        "coord_owner_id": "su-960a52e7-9b11-42ac-8fe9-7e5e7e0da441",
        "identity_history": null
      },
      "original_bootstrap": {
        "agent": "codex",
        "model": "gpt-6-luna:max",
        "account": null,
        "owner_id": "su-960a52e7-9b11-42ac-8fe9-7e5e7e0da441",
        "carry_mode": null,
        "fleet_slug": "nonp2p-bug-drain-luna-max-0930",
        "launched_at": "1791586883991",
        "launched_by": "su-960a52e7-9b11-42ac-8fe9-7e5e7e0da441",
        "account_mode": "default",
        "account_notice": "routing through the inference gateway (auto — it selects an available codex account).",
        "adv_session_id": "39271",
        "idempotency_key": "bootstrap-su:ffddfe9a-e732-47f3-8c89-d0e5cea86887",
        "native_session_id": null
      },
      "exact_native_archive_metadata": null,
      "bounded_precutoff_native_index": {
        "last_ts": null,
        "first_ts": null,
        "last_part": null,
        "first_part": null,
        "retained_parts": 0
      }
    },
    {
      "owner": "su-ab8cc07f-e903-4467-ac45-a32149258170",
      "witness": "2026-10-09 17:45:47.12+00",
      "original_requests": [
        {
          "at": "2026-10-09 17:46:42.741+00",
          "id": "34805876",
          "status": "ok"
        },
        {
          "at": "2026-10-09 18:11:36.733+00",
          "id": "34817497",
          "status": "ok"
        },
        {
          "at": "2026-10-09 18:35:28.141+00",
          "id": "34831365",
          "status": "ok"
        },
        {
          "at": "2026-10-09 18:51:39.411+00",
          "id": "34840615",
          "status": "ok"
        },
        {
          "at": "2026-10-09 19:38:59.231+00",
          "id": "34866872",
          "status": "ok"
        },
        {
          "at": "2026-10-09 20:20:57.978+00",
          "id": "34888135",
          "status": "ok"
        },
        {
          "at": "2026-10-09 21:01:26.49+00",
          "id": "34911877",
          "status": "ok"
        },
        {
          "at": "2026-10-10 00:50:07.858+00",
          "id": "35031313",
          "status": "ok"
        },
        {
          "at": "2026-10-10 01:14:36.716+00",
          "id": "35044097",
          "status": "ok"
        },
        {
          "at": "2026-10-10 01:28:48.821+00",
          "id": "35050968",
          "status": "ok"
        }
      ],
      "original_adv": {
        "id": "39328",
        "agent": "codex",
        "parent": null,
        "ended_at": "2026-10-10 21:16:47.470365+00",
        "session_id": "01a12360-da31-7753-8b52-6276d176e0d8",
        "started_at": "2026-10-10 21:12:50.063092+00",
        "launch_argv": [
          "psu",
          "--no-picker",
          "--agent=codex",
          "--headless",
          "--carry=cold",
          "--harness=papercusp",
          "--no-plan",
          "--model=gpt-6-luna:max",
          "--model-source=explicit",
          "--account=auto",
          "--fleet=nonp2p-bug-drain-luna-max-0930",
          "--auto",
          "--owner-id=su-ab8cc07f-e903-4467-ac45-a32149258170"
        ],
        "launched_at": null,
        "first_seen_at": "2026-10-10 00:01:52.949272+00",
        "coord_owner_id": "su-ab8cc07f-e903-4467-ac45-a32149258170",
        "identity_history": null
      },
      "original_bootstrap": {
        "agent": "codex",
        "model": "gpt-6-luna:max",
        "account": null,
        "owner_id": "su-ab8cc07f-e903-4467-ac45-a32149258170",
        "carry_mode": null,
        "fleet_slug": "nonp2p-bug-drain-luna-max-0930",
        "launched_at": "1791590512923",
        "launched_by": "su-ab8cc07f-e903-4467-ac45-a32149258170",
        "account_mode": "default",
        "account_notice": "routing through the inference gateway (auto — it selects an available codex account).",
        "adv_session_id": "39328",
        "idempotency_key": "bootstrap-su:9c67adbe-2528-4ef5-a8fb-2090f1a485f6",
        "native_session_id": null
      },
      "exact_native_archive_metadata": null,
      "bounded_precutoff_native_index": {
        "last_ts": null,
        "first_ts": null,
        "last_part": null,
        "first_part": null,
        "retained_parts": 0
      }
    },
    {
      "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
      "witness": "2026-10-09 18:30:18.913+00",
      "original_requests": [
        {
          "at": "2026-10-09 18:30:38.971+00",
          "id": "34828463",
          "status": "ok"
        },
        {
          "at": "2026-10-09 21:37:08.769+00",
          "id": "34932173",
          "status": "ok"
        },
        {
          "at": "2026-10-09 21:53:51.826+00",
          "id": "34941445",
          "status": "ok"
        },
        {
          "at": "2026-10-09 22:11:32.49+00",
          "id": "34951995",
          "status": "ok"
        },
        {
          "at": "2026-10-09 23:09:33.199+00",
          "id": "34980537",
          "status": "ok"
        },
        {
          "at": "2026-10-09 23:30:44.05+00",
          "id": "34992385",
          "status": "ok"
        },
        {
          "at": "2026-10-09 23:50:39.075+00",
          "id": "35002236",
          "status": "ok"
        },
        {
          "at": "2026-10-09 23:52:48.874+00",
          "id": "35003363",
          "status": "ok"
        },
        {
          "at": "2026-10-10 00:13:42.729+00",
          "id": "35012964",
          "status": "ok"
        },
        {
          "at": "2026-10-10 00:14:13.317+00",
          "id": "35013188",
          "status": "ok"
        },
        {
          "at": "2026-10-10 00:14:26.04+00",
          "id": "35013284",
          "status": "ok"
        },
        {
          "at": "2026-10-10 00:33:32.347+00",
          "id": "35022684",
          "status": "ok"
        },
        {
          "at": "2026-10-10 01:04:22.9+00",
          "id": "35038763",
          "status": "ok"
        },
        {
          "at": "2026-10-10 01:28:19.074+00",
          "id": "35050614",
          "status": "ok"
        }
      ],
      "original_adv": {
        "id": "39241",
        "agent": "codex",
        "parent": null,
        "ended_at": "2026-10-10 17:15:29.189794+00",
        "session_id": "01a12357-33fa-76b1-9add-840d4be15ec1",
        "started_at": "2026-10-10 01:04:40.155646+00",
        "launch_argv": [
          "psu",
          "--no-picker",
          "--agent=codex",
          "--headless",
          "--carry=cold",
          "--harness=papercusp",
          "--no-plan",
          "--model=gpt-6-luna:max",
          "--model-source=explicit",
          "--account=auto",
          "--fleet=nonp2p-bug-drain-luna-max-0930",
          "--auto",
          "--owner-id=su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100"
        ],
        "launched_at": null,
        "first_seen_at": "2026-10-09 22:32:52.190025+00",
        "coord_owner_id": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
        "identity_history": null
      },
      "original_bootstrap": {
        "agent": "codex",
        "model": "gpt-6-luna:max",
        "account": null,
        "owner_id": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
        "carry_mode": null,
        "fleet_slug": "nonp2p-bug-drain-luna-max-0930",
        "launched_at": "1791585172111",
        "launched_by": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
        "account_mode": "default",
        "account_notice": "routing through the inference gateway (auto — it selects an available codex account).",
        "adv_session_id": "39241",
        "idempotency_key": "bootstrap-su:4f04ea16-73d7-4c6d-b752-c87d68991bac",
        "native_session_id": null
      },
      "exact_native_archive_metadata": null,
      "bounded_precutoff_native_index": {
        "last_ts": null,
        "first_ts": null,
        "last_part": null,
        "first_part": null,
        "retained_parts": 0
      }
    },
    {
      "owner": "su-b7ae044b-c702-4275-8857-d8c0943bc6f6",
      "witness": "2026-10-10 00:58:16.474+00",
      "original_requests": [
        {
          "at": "2026-10-10 01:17:46.77+00",
          "id": "35045161",
          "status": "ok"
        },
        {
          "at": "2026-10-10 01:42:45.515+00",
          "id": "35058458",
          "status": "ok"
        },
        {
          "at": "2026-10-10 03:23:32.184+00",
          "id": "35104998",
          "status": "ok"
        }
      ],
      "original_adv": {
        "id": "39445",
        "agent": "codex",
        "parent": null,
        "ended_at": "2026-10-10 22:10:04.605981+00",
        "session_id": "01a123cc-f94e-7762-904c-3a3fd9ed047f",
        "started_at": "2026-10-10 03:13:19.805953+00",
        "launch_argv": [
          "psu",
          "--no-picker",
          "--agent=codex",
          "--headless",
          "--carry=cold",
          "--harness=papercusp",
          "--no-plan",
          "--model=gpt-6-luna:max",
          "--model-source=explicit",
          "--account=auto",
          "--fleet=nonp2p-bug-drain-luna-max-0930",
          "--auto",
          "--owner-id=su-b7ae044b-c702-4275-8857-d8c0943bc6f6"
        ],
        "launched_at": null,
        "first_seen_at": "2026-10-10 03:13:14.352301+00",
        "coord_owner_id": "su-b7ae044b-c702-4275-8857-d8c0943bc6f6",
        "identity_history": null
      },
      "original_bootstrap": {
        "agent": "codex",
        "model": "gpt-6-luna:max",
        "account": null,
        "owner_id": "su-b7ae044b-c702-4275-8857-d8c0943bc6f6",
        "carry_mode": null,
        "fleet_slug": "nonp2p-bug-drain-luna-max-0930",
        "launched_at": "1791601994303",
        "launched_by": "su-b7ae044b-c702-4275-8857-d8c0943bc6f6",
        "account_mode": "default",
        "account_notice": "routing through the inference gateway (auto — it selects an available codex account).",
        "adv_session_id": "39445",
        "idempotency_key": "bootstrap-su:2af43d14-f3ec-4395-9535-db613bcd6bb9",
        "native_session_id": null
      },
      "exact_native_archive_metadata": null,
      "bounded_precutoff_native_index": {
        "last_ts": null,
        "first_ts": null,
        "last_part": null,
        "first_part": null,
        "retained_parts": 0
      }
    },
    {
      "owner": "su-ba80f2f7-46f6-4aec-b99a-21e02460933f",
      "witness": "2026-10-09 20:38:47.049+00",
      "original_requests": [
        {
          "at": "2026-10-09 20:41:07.843+00",
          "id": "34901238",
          "status": "ok"
        },
        {
          "at": "2026-10-09 21:02:50.537+00",
          "id": "34912704",
          "status": "ok"
        },
        {
          "at": "2026-10-09 21:24:43.235+00",
          "id": "34925297",
          "status": "ok"
        },
        {
          "at": "2026-10-09 21:26:33.72+00",
          "id": "34926174",
          "status": "ok"
        },
        {
          "at": "2026-10-09 23:09:37.086+00",
          "id": "34980575",
          "status": "ok"
        },
        {
          "at": "2026-10-09 23:32:04.106+00",
          "id": "34993138",
          "status": "ok"
        }
      ],
      "original_adv": {
        "id": "39263",
        "agent": "codex",
        "parent": null,
        "ended_at": "2026-10-10 17:15:53.959904+00",
        "session_id": "01a1234f-fefc-7753-8af9-f3e0243ffe82",
        "started_at": "2026-10-10 00:56:47.746381+00",
        "launch_argv": [
          "psu",
          "--no-picker",
          "--agent=codex",
          "--headless",
          "--carry=cold",
          "--harness=papercusp",
          "--no-plan",
          "--model=gpt-6-luna:max",
          "--model-source=explicit",
          "--account=auto",
          "--fleet=nonp2p-bug-drain-luna-max-0930",
          "--auto",
          "--owner-id=su-ba80f2f7-46f6-4aec-b99a-21e02460933f"
        ],
        "launched_at": null,
        "first_seen_at": "2026-10-09 22:47:07.906339+00",
        "coord_owner_id": "su-ba80f2f7-46f6-4aec-b99a-21e02460933f",
        "identity_history": null
      },
      "original_bootstrap": {
        "agent": "codex",
        "model": "gpt-6-luna:max",
        "account": null,
        "owner_id": "su-ba80f2f7-46f6-4aec-b99a-21e02460933f",
        "carry_mode": null,
        "fleet_slug": "nonp2p-bug-drain-luna-max-0930",
        "launched_at": "1791586027851",
        "launched_by": "su-ba80f2f7-46f6-4aec-b99a-21e02460933f",
        "account_mode": "default",
        "account_notice": "routing through the inference gateway (auto — it selects an available codex account).",
        "adv_session_id": "39263",
        "idempotency_key": "bootstrap-su:d14d9ecf-ef69-45a6-9417-b6beeb72dc81",
        "native_session_id": null
      },
      "exact_native_archive_metadata": null,
      "bounded_precutoff_native_index": {
        "last_ts": null,
        "first_ts": null,
        "last_part": null,
        "first_part": null,
        "retained_parts": 0
      }
    },
    {
      "owner": "su-d88420f0-c0b4-4dc7-92c7-f60ab3ddab44",
      "witness": "2026-10-10 06:24:03.423+00",
      "original_requests": [
        {
          "at": "2026-10-10 07:37:54.22+00",
          "id": "35217653",
          "status": "ok"
        },
        {
          "at": "2026-10-10 08:14:45.849+00",
          "id": "35232736",
          "status": "ok"
        },
        {
          "at": "2026-10-10 08:45:27.344+00",
          "id": "35246481",
          "status": "ok"
        },
        {
          "at": "2026-10-10 09:42:40.729+00",
          "id": "35271105",
          "status": "ok"
        },
        {
          "at": "2026-10-10 10:23:54.672+00",
          "id": "35289337",
          "status": "ok"
        }
      ],
      "original_adv": {
        "id": "39675",
        "agent": "codex",
        "parent": null,
        "ended_at": "2026-10-10 22:10:04.378597+00",
        "session_id": "01a125e7-53fd-7891-a404-21f7f9ad9f43",
        "started_at": "2026-10-10 13:01:46.919658+00",
        "launch_argv": [
          "psu",
          "--no-picker",
          "--agent=codex",
          "--headless",
          "--carry=cold",
          "--harness=papercusp",
          "--no-plan",
          "--model=gpt-6-luna:max",
          "--model-source=explicit",
          "--account=auto",
          "--fleet=nonp2p-bug-drain-luna-max-0930",
          "--auto",
          "--owner-id=su-d88420f0-c0b4-4dc7-92c7-f60ab3ddab44"
        ],
        "launched_at": null,
        "first_seen_at": "2026-10-10 13:00:58.260035+00",
        "coord_owner_id": "su-d88420f0-c0b4-4dc7-92c7-f60ab3ddab44",
        "identity_history": null
      },
      "original_bootstrap": {
        "agent": "codex",
        "model": "gpt-6-luna:max",
        "account": null,
        "owner_id": "su-d88420f0-c0b4-4dc7-92c7-f60ab3ddab44",
        "carry_mode": null,
        "fleet_slug": "nonp2p-bug-drain-luna-max-0930",
        "launched_at": "1791637258197",
        "launched_by": "su-d88420f0-c0b4-4dc7-92c7-f60ab3ddab44",
        "account_mode": "default",
        "account_notice": "routing through the inference gateway (auto — it selects an available codex account).",
        "adv_session_id": "39675",
        "idempotency_key": "bootstrap-su:a097f666-97da-43b3-8d1c-1ed6fea5b3d7",
        "native_session_id": null
      },
      "exact_native_archive_metadata": null,
      "bounded_precutoff_native_index": {
        "last_ts": null,
        "first_ts": null,
        "last_part": null,
        "first_part": null,
        "retained_parts": 0
      }
    },
    {
      "owner": "su-ddb4cbf4-2581-4f7c-8d6a-efbb712bd295",
      "witness": "2026-10-09 21:52:52.005+00",
      "original_requests": [
        {
          "at": "2026-10-09 22:44:16.691+00",
          "id": "34967597",
          "status": "ok"
        },
        {
          "at": "2026-10-09 23:11:26.589+00",
          "id": "34981473",
          "status": "ok"
        },
        {
          "at": "2026-10-09 23:36:26.49+00",
          "id": "34994869",
          "status": "ok"
        },
        {
          "at": "2026-10-09 23:37:41.28+00",
          "id": "34995559",
          "status": "ok"
        },
        {
          "at": "2026-10-09 23:56:59.599+00",
          "id": "35005267",
          "status": "ok"
        },
        {
          "at": "2026-10-10 00:31:47.054+00",
          "id": "35021734",
          "status": "ok"
        }
      ],
      "original_adv": {
        "id": "39230",
        "agent": "codex",
        "parent": null,
        "ended_at": "2026-10-10 17:15:36.867897+00",
        "session_id": "01a12356-4811-7080-a02e-863980775e9c",
        "started_at": "2026-10-10 01:03:39.855014+00",
        "launch_argv": [
          "psu",
          "--no-picker",
          "--agent=codex",
          "--headless",
          "--carry=cold",
          "--harness=papercusp",
          "--no-plan",
          "--model=gpt-6-luna:max",
          "--model-source=explicit",
          "--account=auto",
          "--fleet=nonp2p-bug-drain-luna-max-0930",
          "--auto",
          "--owner-id=su-ddb4cbf4-2581-4f7c-8d6a-efbb712bd295"
        ],
        "launched_at": null,
        "first_seen_at": "2026-10-09 22:24:07.335513+00",
        "coord_owner_id": "su-ddb4cbf4-2581-4f7c-8d6a-efbb712bd295",
        "identity_history": null
      },
      "original_bootstrap": {
        "agent": "codex",
        "model": "gpt-6-luna:max",
        "account": null,
        "owner_id": "su-ddb4cbf4-2581-4f7c-8d6a-efbb712bd295",
        "carry_mode": null,
        "fleet_slug": "nonp2p-bug-drain-luna-max-0930",
        "launched_at": "1791584647287",
        "launched_by": "su-ddb4cbf4-2581-4f7c-8d6a-efbb712bd295",
        "account_mode": "default",
        "account_notice": "routing through the inference gateway (auto — it selects an available codex account).",
        "adv_session_id": "39230",
        "idempotency_key": "bootstrap-su:aa745c9c-e383-471c-982f-f5f4d9acc99a",
        "native_session_id": null
      },
      "exact_native_archive_metadata": null,
      "bounded_precutoff_native_index": {
        "last_ts": null,
        "first_ts": null,
        "last_part": null,
        "first_part": null,
        "retained_parts": 0
      }
    },
    {
      "owner": "su-de5729a7-76d6-4498-8766-c084b2502a21",
      "witness": "2026-10-10 05:53:09.939+00",
      "original_requests": [
        {
          "at": "2026-10-10 06:55:57.626+00",
          "id": "35200300",
          "status": "ok"
        }
      ],
      "original_adv": {
        "id": "39534",
        "agent": "codex",
        "parent": null,
        "ended_at": "2026-10-10 22:10:04.444674+00",
        "session_id": "01a12489-abcc-7ff3-b35a-a8a84157896e",
        "started_at": "2026-10-10 06:39:24.925638+00",
        "launch_argv": [
          "psu",
          "--no-picker",
          "--agent=codex",
          "--headless",
          "--carry=cold",
          "--harness=papercusp",
          "--no-plan",
          "--model=gpt-6-luna:max",
          "--model-source=explicit",
          "--account=auto",
          "--fleet=nonp2p-bug-drain-luna-max-0930",
          "--auto",
          "--owner-id=su-de5729a7-76d6-4498-8766-c084b2502a21"
        ],
        "launched_at": null,
        "first_seen_at": "2026-10-10 06:39:19.067901+00",
        "coord_owner_id": "su-de5729a7-76d6-4498-8766-c084b2502a21",
        "identity_history": null
      },
      "original_bootstrap": {
        "agent": "codex",
        "model": "gpt-6-luna:max",
        "account": null,
        "owner_id": "su-de5729a7-76d6-4498-8766-c084b2502a21",
        "carry_mode": null,
        "fleet_slug": "nonp2p-bug-drain-luna-max-0930",
        "launched_at": "1791614359030",
        "launched_by": "su-de5729a7-76d6-4498-8766-c084b2502a21",
        "account_mode": "default",
        "account_notice": "routing through the inference gateway (auto — it selects an available codex account).",
        "adv_session_id": "39534",
        "idempotency_key": "bootstrap-su:c3d0f103-f791-41c3-87c4-1e11a5875f0c",
        "native_session_id": null
      },
      "exact_native_archive_metadata": null,
      "bounded_precutoff_native_index": {
        "last_ts": null,
        "first_ts": null,
        "last_part": null,
        "first_part": null,
        "retained_parts": 0
      }
    },
    {
      "owner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
      "witness": "2026-10-06 11:52:18.49+00",
      "original_requests": [
        {
          "at": "2026-10-06 11:53:24.511+00",
          "id": "32189831",
          "status": "ok"
        },
        {
          "at": "2026-10-06 12:22:44.955+00",
          "id": "32205045",
          "status": "ok"
        },
        {
          "at": "2026-10-06 12:44:00.675+00",
          "id": "32216380",
          "status": "ok"
        },
        {
          "at": "2026-10-06 13:12:32.063+00",
          "id": "32231391",
          "status": "ok"
        },
        {
          "at": "2026-10-06 13:34:59.639+00",
          "id": "32243511",
          "status": "ok"
        },
        {
          "at": "2026-10-06 14:03:27.689+00",
          "id": "32259530",
          "status": "ok"
        },
        {
          "at": "2026-10-06 17:17:20.335+00",
          "id": "32327156",
          "status": "ok"
        },
        {
          "at": "2026-10-09 21:25:47.058+00",
          "id": "34925804",
          "status": "ok"
        },
        {
          "at": "2026-10-09 21:45:46.61+00",
          "id": "34937571",
          "status": "ok"
        },
        {
          "at": "2026-10-09 22:38:32.257+00",
          "id": "34964960",
          "status": "ok"
        },
        {
          "at": "2026-10-09 23:38:02.064+00",
          "id": "34995729",
          "status": "ok"
        },
        {
          "at": "2026-10-10 00:02:20.661+00",
          "id": "35007728",
          "status": "ok"
        },
        {
          "at": "2026-10-10 00:18:05.707+00",
          "id": "35015047",
          "status": "ok"
        },
        {
          "at": "2026-10-10 00:59:05.49+00",
          "id": "35035804",
          "status": "ok"
        },
        {
          "at": "2026-10-10 01:20:21.639+00",
          "id": "35046373",
          "status": "ok"
        }
      ],
      "original_adv": {
        "id": "39233",
        "agent": "codex",
        "parent": null,
        "ended_at": "2026-10-10 17:15:49.775678+00",
        "session_id": "01a12352-48ef-7a32-b5d6-001dc022af23",
        "started_at": "2026-10-10 00:59:17.809493+00",
        "launch_argv": [
          "psu",
          "--no-picker",
          "--agent=codex",
          "--headless",
          "--carry=cold",
          "--harness=papercusp",
          "--no-plan",
          "--model=gpt-6-luna:max",
          "--model-source=explicit",
          "--account=auto",
          "--fleet=nonp2p-bug-drain-luna-max-0930",
          "--auto",
          "--owner-id=su-f0e98560-52c5-4afe-8709-46fef49a576e"
        ],
        "launched_at": null,
        "first_seen_at": "2026-10-09 22:24:45.661433+00",
        "coord_owner_id": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
        "identity_history": null
      },
      "original_bootstrap": {
        "agent": "codex",
        "model": "gpt-6-luna:max",
        "account": null,
        "owner_id": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
        "carry_mode": null,
        "fleet_slug": "nonp2p-bug-drain-luna-max-0930",
        "launched_at": "1791584685629",
        "launched_by": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
        "account_mode": "default",
        "account_notice": "routing through the inference gateway (auto — it selects an available codex account).",
        "adv_session_id": "39233",
        "idempotency_key": "bootstrap-su:3b15b4c9-375f-4c1e-b673-65fe98e3cfce",
        "native_session_id": null
      },
      "exact_native_archive_metadata": null,
      "bounded_precutoff_native_index": {
        "last_ts": null,
        "first_ts": null,
        "last_part": null,
        "first_part": null,
        "retained_parts": 0
      }
    },
    {
      "owner": "su-f6b6fcca-f4f9-484f-86ca-974378824a67",
      "witness": "2026-10-10 03:09:50.929+00",
      "original_requests": [
        {
          "at": "2026-10-10 03:11:26.131+00",
          "id": "35099069",
          "status": "ok"
        },
        {
          "at": "2026-10-10 03:47:01.192+00",
          "id": "35115120",
          "status": "ok"
        }
      ],
      "original_adv": {
        "id": "37831",
        "agent": "codex",
        "parent": null,
        "ended_at": "2026-10-10 17:14:30.030179+00",
        "session_id": "01a123dd-2b69-75b2-8323-c43e797bca78",
        "started_at": "2026-10-10 03:30:59.745328+00",
        "launch_argv": [
          "psu",
          "--no-picker",
          "--agent=codex",
          "--headless",
          "--carry=cold",
          "--harness=papercusp",
          "--no-plan",
          "--model=gpt-6-luna:max",
          "--model-source=explicit",
          "--account=auto",
          "--fleet=nonp2p-bug-drain-luna-max-0930",
          "--auto",
          "--owner-id=su-f6b6fcca-f4f9-484f-86ca-974378824a67"
        ],
        "launched_at": null,
        "first_seen_at": "2026-10-08 13:06:28.356697+00",
        "coord_owner_id": "su-f6b6fcca-f4f9-484f-86ca-974378824a67",
        "identity_history": null
      },
      "original_bootstrap": {
        "agent": "codex",
        "model": "gpt-6-luna:max",
        "account": null,
        "owner_id": "su-f6b6fcca-f4f9-484f-86ca-974378824a67",
        "carry_mode": null,
        "fleet_slug": "nonp2p-bug-drain-luna-max-0930",
        "launched_at": "1791464788280",
        "launched_by": "su-f6b6fcca-f4f9-484f-86ca-974378824a67",
        "account_mode": "default",
        "account_notice": "routing through the inference gateway (auto — it selects an available codex account).",
        "adv_session_id": "37831",
        "idempotency_key": "bootstrap-su:6eec5bcb-645f-4ce3-a405-e375be1c7465",
        "native_session_id": null
      },
      "exact_native_archive_metadata": null,
      "bounded_precutoff_native_index": {
        "last_ts": null,
        "first_ts": null,
        "last_part": null,
        "first_part": null,
        "retained_parts": 0
      }
    },
    {
      "owner": "su-f6e9cbee-faee-465e-9281-2743f85a91ab",
      "witness": "2026-10-10 02:05:39.736+00",
      "original_requests": [
        {
          "at": "2026-10-10 02:09:52.703+00",
          "id": "35069597",
          "status": "refused"
        },
        {
          "at": "2026-10-10 03:07:21.967+00",
          "id": "35096877",
          "status": "ok"
        }
      ],
      "original_adv": {
        "id": "39436",
        "agent": "codex",
        "parent": null,
        "ended_at": "2026-10-10 17:15:11.647355+00",
        "session_id": "01a123b8-2a5c-74e1-b654-b4b7df566a9e",
        "started_at": "2026-10-10 02:50:34.583717+00",
        "launch_argv": [
          "psu",
          "--no-picker",
          "--agent=codex",
          "--headless",
          "--carry=cold",
          "--harness=papercusp",
          "--no-plan",
          "--model=gpt-6-luna:max",
          "--model-source=explicit",
          "--account=auto",
          "--fleet=nonp2p-bug-drain-luna-max-0930",
          "--auto",
          "--owner-id=su-f6e9cbee-faee-465e-9281-2743f85a91ab"
        ],
        "launched_at": null,
        "first_seen_at": "2026-10-10 02:50:31.637083+00",
        "coord_owner_id": "su-f6e9cbee-faee-465e-9281-2743f85a91ab",
        "identity_history": null
      },
      "original_bootstrap": {
        "agent": "codex",
        "model": "gpt-6-luna:max",
        "account": null,
        "owner_id": "su-f6e9cbee-faee-465e-9281-2743f85a91ab",
        "carry_mode": null,
        "fleet_slug": "nonp2p-bug-drain-luna-max-0930",
        "launched_at": "1791600631607",
        "launched_by": "su-f6e9cbee-faee-465e-9281-2743f85a91ab",
        "account_mode": "default",
        "account_notice": "routing through the inference gateway (auto — it selects an available codex account).",
        "adv_session_id": "39436",
        "idempotency_key": "bootstrap-su:067f0343-37cd-4f5e-a974-a1f9923da6f1",
        "native_session_id": null
      },
      "exact_native_archive_metadata": null,
      "bounded_precutoff_native_index": {
        "last_ts": null,
        "first_ts": null,
        "last_part": null,
        "first_part": null,
        "retained_parts": 0
      }
    },
    {
      "owner": "su-faf26552-0633-4081-a250-172c02f07c19",
      "witness": "2026-10-10 03:01:47.585+00",
      "original_requests": [
        {
          "at": "2026-10-10 03:02:12.503+00",
          "id": "35093983",
          "status": "ok"
        },
        {
          "at": "2026-10-10 03:19:29.336+00",
          "id": "35103184",
          "status": "ok"
        },
        {
          "at": "2026-10-10 03:32:41.152+00",
          "id": "35108257",
          "status": "ok"
        },
        {
          "at": "2026-10-10 04:00:21.361+00",
          "id": "35121480",
          "status": "ok"
        },
        {
          "at": "2026-10-10 04:52:19.47+00",
          "id": "35145396",
          "status": "ok"
        }
      ],
      "original_adv": {
        "id": "35773",
        "agent": "codex",
        "parent": "su-3ae55b3b-8547-4852-bff2-07f7019f03f3",
        "ended_at": "2026-10-10 19:07:16.553422+00",
        "session_id": "01a12429-8730-7db0-b2bf-afcc88a8d58b",
        "started_at": "2026-10-10 04:54:25.211496+00",
        "launch_argv": [
          "psu",
          "--no-picker",
          "--agent=codex",
          "--headless",
          "--carry=warm",
          "--workspace=papercusp-workspace",
          "--harness=papercusp",
          "--no-plan",
          "--model=gpt-6-luna:max",
          "--model-source=explicit",
          "--account=auto",
          "--fleet=nonp2p-bug-drain-luna-max-0930",
          "--auto",
          "--launched-by=su-3ae55b3b-8547-4852-bff2-07f7019f03f3",
          "--owner-id=su-faf26552-0633-4081-a250-172c02f07c19"
        ],
        "launched_at": null,
        "first_seen_at": "2026-10-06 22:49:13.996864+00",
        "coord_owner_id": "su-faf26552-0633-4081-a250-172c02f07c19",
        "identity_history": null
      },
      "original_bootstrap": {
        "agent": "codex",
        "model": "gpt-6-luna:max",
        "account": null,
        "owner_id": "su-faf26552-0633-4081-a250-172c02f07c19",
        "carry_mode": null,
        "fleet_slug": "nonp2p-bug-drain-luna-max-0930",
        "launched_at": "1791326951914",
        "launched_by": "su-3ae55b3b-8547-4852-bff2-07f7019f03f3",
        "account_mode": "default",
        "account_notice": "routing through the inference gateway (auto — it selects an available codex account).",
        "adv_session_id": "35773",
        "idempotency_key": "bootstrap-su:05e3d260-41cb-4741-9e24-7e37fd2b3748",
        "native_session_id": null
      },
      "exact_native_archive_metadata": null,
      "bounded_precutoff_native_index": {
        "last_ts": null,
        "first_ts": null,
        "last_part": null,
        "first_part": null,
        "retained_parts": 0
      }
    }
  ],
  "limits": [
    "Originaladv/native coordinates inherit custody artifact warning: mutableadv columns do not attest original-as-of identity alone.",
    "Archive metadata presence is source custody, not source contents or cutoff continuity.",
    "Retainedparts count measures indexed table rows for exactworkspace+owner+native+cutoff, never global source absence.",
    "No eligibility decisions or recovery outcome joins."
  ],
  "summary": {
    "population": 21,
    "archiveMetadataOwners": 0,
    "indexedPartOwners": 0,
    "cutoffContinuityAccepted": 0,
    "outcomesJoined": 0
  }
}
