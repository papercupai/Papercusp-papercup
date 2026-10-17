---
rel_path: "evidence/WI-6554700010013074/R19/source-qualification-fec6d834d5fc0dbccbcae372ade2539b8a3b4c635106af691c9c311f2734b166.json"
updated_at: 1792187844081
_body: "content"
---

{
  "schemaVersion": 1,
  "kind": "original-r19-source-qualification",
  "workItemId": "WI-6554700010013074",
  "criterion": "R-19",
  "rubricRevision": 9,
  "rubricCriteriaHash": "390ce345aaae72ed39b9c6f1a147d333fce1ca6b697ffb5c8900230d6da528ab",
  "source": {
    "slug": "papercusp",
    "rel_path": "evidence/WI-6554700010013074/R19/original-window-20261009T140000Z-20261016T140000Z-eb985f48ba01627e336762bd42a6eeeb69b821de18a24c88640d2a5e25d9819b.json",
    "sha256": "eb985f48ba01627e336762bd42a6eeeb69b821de18a24c88640d2a5e25d9819b",
    "populationSha256": "fa7c5aaec15354bf37b6812cb849f065123f6bf6658f5381bdc0f74cc165d4b8",
    "window": {
      "start": "2026-10-09T14:00:00Z",
      "end": "2026-10-16T14:00:00Z",
      "startMs": 1791554400000,
      "endMs": 1792159200000
    },
    "counts": {
      "greenCheckpoint": 269,
      "repairLatency": 210,
      "persistedAdmissionAudits": 72
    }
  },
  "result": "unknown",
  "acceptance": false,
  "qualification": "The fixed historical population does not establish a complete authenticated adjacent pair. No evaluator invocation or operational test receipt is claimed.",
  "sourceVerification": {
    "fullCanonicalByteReadback": true,
    "fullOriginalPopulationRequeryHashEqual": true,
    "originalLogs": [
      {
        "eventId": "660465",
        "runId": "e7bd7f28-c4a8-48d0-8ca3-a94eeefd29bd",
        "path": "/home/marsh-office/.papercusp/checkpoint-logs/2026-10-12T14-46-06-191Z-base-d740fc380287-cand-70e89c73d66f-early-typecheck.log",
        "rel_path": "evidence/WI-6554700010013074/R19/original-logs/c9b669ce06036bb8c4eb72a67ca6b50295294e28cc040564ba3f5280c6a876af.log",
        "sha256": "c9b669ce06036bb8c4eb72a67ca6b50295294e28cc040564ba3f5280c6a876af",
        "bytes": 65530,
        "runIdPresent": true
      },
      {
        "eventId": "665592",
        "runId": "4bbfb5d7-e0ca-456a-9089-e0c31d10b29d",
        "path": "/home/marsh-office/.papercusp/checkpoint-logs/2026-10-13T03-15-54-766Z-base-d740fc380287-cand-0a16d4a6fac2-early-typecheck.log",
        "rel_path": "evidence/WI-6554700010013074/R19/original-logs/6f02b23fc9447f0038628c10cd72e8c4ccc5569c00afa8dfca036df81f6eafb9.log",
        "sha256": "6f02b23fc9447f0038628c10cd72e8c4ccc5569c00afa8dfca036df81f6eafb9",
        "bytes": 98590,
        "runIdPresent": true
      },
      {
        "eventId": "673132",
        "runId": "0605a439-27f4-4da4-a64d-cffc922f68a8",
        "path": "/home/marsh-office/.papercusp/checkpoint-logs/2026-10-13T19-15-17-324Z-base-d740fc380287-cand-4a0ab75652bd-early-typecheck.log",
        "rel_path": "evidence/WI-6554700010013074/R19/original-logs/92406853240e56d09b956384210de1a84e19572879ec7ab856aa56c096c2dbb9.log",
        "sha256": "92406853240e56d09b956384210de1a84e19572879ec7ab856aa56c096c2dbb9",
        "bytes": 74917,
        "runIdPresent": true
      },
      {
        "eventId": "687049",
        "runId": "b6abcc94-7070-48be-9acb-355f2c831f0e",
        "path": "/home/marsh-office/.papercusp/checkpoint-logs/2026-10-14T22-41-12-240Z-base-d740fc380287-cand-0e2f2291d577-early-typecheck.log",
        "rel_path": "evidence/WI-6554700010013074/R19/original-logs/9a0138793db83e95deef3d3f5d4741f4913e81bca5a788975f0d8c9816219534.log",
        "sha256": "9a0138793db83e95deef3d3f5d4741f4913e81bca5a788975f0d8c9816219534",
        "bytes": 104121,
        "runIdPresent": true
      }
    ]
  },
  "rounds": [
    {
      "candidate": "4a0ab75652bda2698d296eee96aa340f0eb3a620",
      "openedAtMs": 1791915580374,
      "ordinal": 1,
      "head": "4a0ab75652bda2698d296eee96aa340f0eb3a620",
      "verdictAtMs": 1791918930797,
      "sourceSnapshotId": "679925",
      "previous": null,
      "admissions": null,
      "nearbyOriginalRunIds": [
        {
          "eventId": "673130",
          "runId": "0605a439-27f4-4da4-a64d-cffc922f68a8",
          "candidateDisplay": "4a0ab75652bd",
          "hasMeasuredPhases": false,
          "logPath": "/home/marsh-office/.papercusp/checkpoint-logs/2026-10-13T19-15-17-324Z-base-d740fc380287-cand-4a0ab75652bd-early-typecheck.log"
        },
        {
          "eventId": "673132",
          "runId": "0605a439-27f4-4da4-a64d-cffc922f68a8",
          "candidateDisplay": "4a0ab75652bd",
          "hasMeasuredPhases": true,
          "logPath": "/home/marsh-office/.papercusp/checkpoint-logs/2026-10-13T19-15-17-324Z-base-d740fc380287-cand-4a0ab75652bd-early-typecheck.log"
        }
      ],
      "qualification": "not accepted; nearby-clock/display matching is candidate discovery only, not full-head execution identity"
    },
    {
      "candidate": "4a0ab75652bda2698d296eee96aa340f0eb3a620",
      "openedAtMs": 1791915580374,
      "ordinal": 2,
      "head": "09b03f6f38c5e69a5a05c4ebdbf7ac11a7b63b30",
      "verdictAtMs": 1791935608144,
      "sourceSnapshotId": "679925",
      "previous": {
        "head": "4a0ab75652bda2698d296eee96aa340f0eb3a620",
        "ordinal": 1,
        "verdictAtMs": 1791918930797
      },
      "admissions": [
        {
          "atMs": 1791924893676,
          "toRepairHead": "55bbd12ce1686d8e722b5a733f5a68783f40b08d",
          "fromRepairHead": "4a0ab75652bda2698d296eee96aa340f0eb3a620",
          "auditIds": [
            "repair-queue-mv75tqkg-p7uxot"
          ]
        },
        {
          "atMs": 1791927120890,
          "toRepairHead": "09b03f6f38c5e69a5a05c4ebdbf7ac11a7b63b30",
          "fromRepairHead": "55bbd12ce1686d8e722b5a733f5a68783f40b08d",
          "auditIds": []
        }
      ],
      "nearbyOriginalRunIds": [],
      "qualification": "not accepted; nearby-clock/display matching is candidate discovery only, not full-head execution identity"
    },
    {
      "candidate": "4a0ab75652bda2698d296eee96aa340f0eb3a620",
      "openedAtMs": 1791915580374,
      "ordinal": 3,
      "head": "09b03f6f38c5e69a5a05c4ebdbf7ac11a7b63b30",
      "verdictAtMs": 1791947705172,
      "sourceSnapshotId": "679925",
      "previous": {
        "head": "09b03f6f38c5e69a5a05c4ebdbf7ac11a7b63b30",
        "ordinal": 2,
        "verdictAtMs": 1791935608144
      },
      "admissions": [],
      "nearbyOriginalRunIds": [],
      "qualification": "not accepted; nearby-clock/display matching is candidate discovery only, not full-head execution identity"
    },
    {
      "candidate": "0e2f2291d5778a59fd18c5f0ef29f76b2ed7ae0e",
      "openedAtMs": 1792013717973,
      "ordinal": 1,
      "head": "0e2f2291d5778a59fd18c5f0ef29f76b2ed7ae0e",
      "verdictAtMs": 1792017693904,
      "sourceSnapshotId": "687048",
      "previous": null,
      "admissions": null,
      "nearbyOriginalRunIds": [
        {
          "eventId": "687042",
          "runId": "b6abcc94-7070-48be-9acb-355f2c831f0e",
          "candidateDisplay": "0e2f2291d577",
          "hasMeasuredPhases": false,
          "logPath": "/home/marsh-office/.papercusp/checkpoint-logs/2026-10-14T22-41-12-240Z-base-d740fc380287-cand-0e2f2291d577-early-typecheck.log"
        },
        {
          "eventId": "687049",
          "runId": "b6abcc94-7070-48be-9acb-355f2c831f0e",
          "candidateDisplay": "0e2f2291d577",
          "hasMeasuredPhases": true,
          "logPath": "/home/marsh-office/.papercusp/checkpoint-logs/2026-10-14T22-41-12-240Z-base-d740fc380287-cand-0e2f2291d577-early-typecheck.log"
        }
      ],
      "qualification": "not accepted; nearby-clock/display matching is candidate discovery only, not full-head execution identity"
    },
    {
      "candidate": "0e2f2291d5778a59fd18c5f0ef29f76b2ed7ae0e",
      "openedAtMs": 1792013717973,
      "ordinal": 2,
      "head": "0e2f2291d5778a59fd18c5f0ef29f76b2ed7ae0e",
      "verdictAtMs": 1792076057282,
      "sourceSnapshotId": "695650",
      "previous": {
        "head": "0e2f2291d5778a59fd18c5f0ef29f76b2ed7ae0e",
        "ordinal": 1,
        "verdictAtMs": 1792017693904
      },
      "admissions": null,
      "nearbyOriginalRunIds": [],
      "qualification": "not accepted; nearby-clock/display matching is candidate discovery only, not full-head execution identity"
    }
  ],
  "reasons": [
    "The only observed adjacent repair ordinals >=2 are 4a0ab756... round2/round3; their judged head is identical.",
    "Round2 has two original admission records but the second transition55bbd12c...->09b03f6f... has no matching persisted admission audit in the complete72-row scoped audit population.",
    "Round3 has no original admission after round2 verdict; a nonempty admitted-path population is not established.",
    "No original green_checkpoint runId/log/phase record is joined to round2 or round3 in the saved window; missing execution fields are not synthesized.",
    "The second observed incarnation0e2f2291... has round1/round2 only, with no original admissionHistory for round2 and no matching original run receipt at its verdict.",
    "Four standalone original phase/log rows do not substitute for the required adjacent admitted-round pair."
  ],
  "limitations": [
    "Only the exact Oct9T14Z..Oct16T14Z population is covered; no current gate verdict or other time window is assessed.",
    "Audit scope is workspace-qualified; install qualification still requires original candidate/transition matches.",
    "No scalar above is an operational acceptance pass; R-19/P-035 remains open.",
    "R20 run21280156 FAIL and binding53456 unknown currentness/draft clause remain unchanged."
  ]
}

