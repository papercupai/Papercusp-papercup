---
rel_path: "audits/parked-agent-resumption-2026-10-09/r13-cold30-original137-custody-assessment-424d5.json"
updated_at: 1791903142302
_body: "content"
---

{
  "schemaVersion": "cold30-original137-combined-custody-v1",
  "observedAt": "2026-10-13T14:52:15.699499+00:00",
  "cutoff": "2026-10-10T16:00:36.515Z",
  "cohortHash": "24ff6981fd54f120f96381dd93732ec9c1bfb2101d7eec063119bf85caeb163a",
  "sourceRefs": [
    "audits/parked-agent-resumption-2026-10-09/r13-cold27-original137-custody-assessment-424d5.json",
    "audits/parked-agent-resumption-2026-10-09/r13-cold30-recovered-native01a1113e-original32231391-assessment-424d5.json",
    "audits/parked-agent-resumption-2026-10-09/r13-cold28-backup-original-native-01a1113e-65dd-7822-9033-cde625ea52e3-424d5.jsonl",
    "audits/parked-agent-resumption-2026-10-09/r13-cold26-native-analysis-instrument-424d5.json"
  ],
  "readback": [
    {
      "ref": "audits/parked-agent-resumption-2026-10-09/r13-cold27-original137-custody-assessment-424d5.json",
      "sha256": "b0c218f70d54bde66da822d0a14fec696115357e346400294b585239d7935c51",
      "fullExactReadback": true
    },
    {
      "ref": "audits/parked-agent-resumption-2026-10-09/r13-cold28-backup-original-native-01a1113e-65dd-7822-9033-cde625ea52e3-424d5.jsonl",
      "sha256": "3bfaaf16eeda428205069f642a3e9a105cfefc7ed82b072debab1344200b0c5e",
      "fullExactReadback": true
    }
  ],
  "summary": {
    "population": 137,
    "prior92Immutable": 92,
    "newComplete": 1,
    "custodyComplete": 93,
    "queued": 91,
    "flushRefused": 1,
    "noHostRefused": 1,
    "unresolved": 44,
    "nativePairCollisions": 0,
    "continuityAccepted": 0,
    "eligibilityAccepted": 0,
    "outcomesJoined": 0
  },
  "newIds": [
    "32231391"
  ],
  "rows": [
    {
      "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
      "request_id": "34777625",
      "ledgerStatus": "refused",
      "candidates": 2,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a12170-b27a-7952-9a19-5139980985b3",
          "callPart": 201,
          "resultPart": 202,
          "literalArgsEqual": true,
          "ledgerOwner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-09 16:47:57.783+00",
          "durationMs": 673,
          "derivedDispatchStart": "2026-10-09T16:47:57.110Z",
          "callTimestamp": "2026-10-09T16:47:56.71+00:00",
          "responseTimestamp": "2026-10-09T16:47:58.472+00:00",
          "callBeforeDispatchMs": 400,
          "responseAfterSettleMs": 689,
          "bounds": true,
          "noAmbiguity": true,
          "format": "json",
          "textBlocks": 1,
          "body": {
            "ok": false,
            "requested": false,
            "error": "flush-required",
            "tripwires": [
              {
                "kind": "missing-checkpoint",
                "subject": "EI-25519734441837999",
                "detail": "EI-25519734441837999 has NO checkpoint written — its in-flight state will not carry."
              }
            ],
            "note": "Compaction is HELD: unflushed state would be lost across the boundary. Flush first, then retry:\n- write a checkpoint for EI-25519734441837999 — work_items:checkpoint { id, checkpoint } (no in-flight state survives without it)\nIf you retry WITHOUT flushing, the system will write a mechanical fallback checkpoint for you and proceed — but a checkpoint you write yourself carries far more than the mechanical one."
          },
          "state": "flush-refused",
          "statusAgrees": true,
          "accepted": true
        }
      ],
      "rejected": [],
      "receiptState": "flush-refused",
      "acceptedUnique": true,
      "reason": null
    },
    {
      "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
      "request_id": "34778962",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a12170-b27a-7952-9a19-5139980985b3",
          "callPart": 223,
          "resultPart": 224,
          "literalArgsEqual": true,
          "ledgerOwner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-09 16:50:34.127+00",
          "durationMs": 6691,
          "derivedDispatchStart": "2026-10-09T16:50:27.436Z",
          "callTimestamp": "2026-10-09T16:50:26.627+00:00",
          "responseTimestamp": "2026-10-09T16:50:34.897+00:00",
          "callBeforeDispatchMs": 809,
          "responseAfterSettleMs": 770,
          "bounds": true,
          "noAmbiguity": true,
          "format": "toon",
          "textBlocks": 2,
          "body": {
            "ok": true,
            "requested": true,
            "respawn": "queued",
            "budgetChars": 331360,
            "firstPromptSource": "continuation-note",
            "staleCheckpoints": [],
            "openOwnerQuestion": false,
            "priorRespawn": {
              "outcome": "none"
            },
            "note": "Carry-respawn QUEUED — not performed yet. The host cuts this process only once your pty goes QUIET at a clean boundary, then respawns your successor on the deterministic carry document. It re-polls for a few minutes and can terminally DROP the carry — an interactive back-and-forth, or steady output, can supersede it indefinitely. So: wrap up and go quiet now, but FLUSH durable state first (work_items:checkpoint / loop:checkpoint / facts:assert) rather than relying on the cut. If you are still here on your next turn, it did not happen — re-request at the next clean stopping point instead of waiting."
          },
          "state": "queued",
          "statusAgrees": true,
          "accepted": true
        }
      ],
      "rejected": [],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null
    },
    {
      "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
      "request_id": "34836638",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a121ec-3bd5-72d3-a76b-bb3efb3cdf99",
          "callPart": 106,
          "resultPart": 107,
          "literalArgsEqual": true,
          "ledgerOwner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-09 18:45:20.521+00",
          "durationMs": 688,
          "derivedDispatchStart": "2026-10-09T18:45:19.833Z",
          "callTimestamp": "2026-10-09T18:45:19.622+00:00",
          "responseTimestamp": "2026-10-09T18:45:22.495+00:00",
          "callBeforeDispatchMs": 211,
          "responseAfterSettleMs": 1974,
          "bounds": true,
          "noAmbiguity": true,
          "format": "toon",
          "textBlocks": 3,
          "body": {
            "ok": true,
            "requested": true,
            "respawn": "queued",
            "budgetChars": 331360,
            "firstPromptSource": "continuation-note",
            "staleCheckpoints": [],
            "openOwnerQuestion": true,
            "priorRespawn": {
              "outcome": "pending",
              "reason": "busy-gate-expired",
              "ts": "2026-10-09T18:31:38.536Z",
              "ageMs": 821973,
              "capMs": 360000
            },
            "note": "Carry-respawn QUEUED — not performed yet. The host cuts this process only once your pty goes QUIET at a clean boundary, then respawns your successor on the deterministic carry document. It re-polls for a few minutes and can terminally DROP the carry — an interactive back-and-forth, or steady output, can supersede it indefinitely. So: wrap up and go quiet now, but FLUSH durable state first (work_items:checkpoint / loop:checkpoint / facts:assert) rather than relying on the cut. If you are still here on your next turn, it did not happen — re-request at the next clean stopping point instead of waiting. ⚠ open-owner-question: your owner's final message looks UNANSWERED at this DELIBERATE boundary. It is NOT lost — it becomes your successor’s first prompt — but if you have room, answer it before you stop. ⚠ prior-respawn-DELAYED: an earlier carry-respawn on this session was queued 14m ago (host recorded `busy-gate-expired`) with no recorded terminal outcome. Its wait interval (360s) is not the request lifetime. The controller may still be retrying and may adopt this newer carry. Inspect its current state and verify the native continuation before inferring loss, delivery, or a new attempt. Keep flushing state durably rather than relying on the carry."
          },
          "state": "queued",
          "statusAgrees": true,
          "accepted": true
        }
      ],
      "rejected": [],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null
    },
    {
      "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
      "request_id": "34902121",
      "ledgerStatus": "ok",
      "candidates": 2,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a12252-f80e-7341-b478-2a4df19537b8",
          "callPart": 129,
          "resultPart": 130,
          "literalArgsEqual": true,
          "ledgerOwner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-09 20:42:45.718+00",
          "durationMs": 744,
          "derivedDispatchStart": "2026-10-09T20:42:44.974Z",
          "callTimestamp": "2026-10-09T20:42:44.597+00:00",
          "responseTimestamp": "2026-10-09T20:42:46.036+00:00",
          "callBeforeDispatchMs": 377,
          "responseAfterSettleMs": 318,
          "bounds": true,
          "noAmbiguity": true,
          "format": "toon",
          "textBlocks": 2,
          "body": {
            "ok": true,
            "requested": true,
            "respawn": "queued",
            "budgetChars": 331360,
            "firstPromptSource": "continuation-note",
            "staleCheckpoints": [],
            "openOwnerQuestion": true,
            "priorRespawn": {
              "outcome": "pending",
              "reason": "busy-gate-expired",
              "ts": "2026-10-09T20:25:35.180Z",
              "ageMs": 1030524,
              "capMs": 360000
            },
            "note": "Carry-respawn QUEUED — not performed yet. The host cuts this process only once your pty goes QUIET at a clean boundary, then respawns your successor on the deterministic carry document. It re-polls for a few minutes and can terminally DROP the carry — an interactive back-and-forth, or steady output, can supersede it indefinitely. So: wrap up and go quiet now, but FLUSH durable state first (work_items:checkpoint / loop:checkpoint / facts:assert) rather than relying on the cut. If you are still here on your next turn, it did not happen — re-request at the next clean stopping point instead of waiting. ⚠ open-owner-question: your owner's final message looks UNANSWERED at this DELIBERATE boundary. It is NOT lost — it becomes your successor’s first prompt — but if you have room, answer it before you stop. ⚠ prior-respawn-DELAYED: an earlier carry-respawn on this session was queued 17m ago (host recorded `busy-gate-expired`) with no recorded terminal outcome. Its wait interval (360s) is not the request lifetime. The controller may still be retrying and may adopt this newer carry. Inspect its current state and verify the native continuation before inferring loss, delivery, or a new attempt. Keep flushing state durably rather than relying on the carry."
          },
          "state": "queued",
          "statusAgrees": true,
          "accepted": true
        }
      ],
      "rejected": [],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null
    },
    {
      "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
      "request_id": "34920158",
      "ledgerStatus": "ok",
      "candidates": 2,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a1227b-6132-7f23-a3c0-e69283dfe44e",
          "callPart": 81,
          "resultPart": 82,
          "literalArgsEqual": true,
          "ledgerOwner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-09 21:14:47.192+00",
          "durationMs": 1572,
          "derivedDispatchStart": "2026-10-09T21:14:45.620Z",
          "callTimestamp": "2026-10-09T21:14:45.29+00:00",
          "responseTimestamp": "2026-10-09T21:14:48.84+00:00",
          "callBeforeDispatchMs": 330,
          "responseAfterSettleMs": 1648,
          "bounds": true,
          "noAmbiguity": true,
          "format": "toon",
          "textBlocks": 2,
          "body": {
            "ok": true,
            "requested": true,
            "respawn": "queued",
            "budgetChars": 331360,
            "firstPromptSource": "continuation-note",
            "staleCheckpoints": [],
            "openOwnerQuestion": false,
            "priorRespawn": {
              "outcome": "delivered",
              "ts": "2026-10-09T21:05:00.356Z",
              "ageMs": 586805,
              "capMs": null
            },
            "note": "Carry-respawn QUEUED — not performed yet. The host cuts this process only once your pty goes QUIET at a clean boundary, then respawns your successor on the deterministic carry document. It re-polls for a few minutes and can terminally DROP the carry — an interactive back-and-forth, or steady output, can supersede it indefinitely. So: wrap up and go quiet now, but FLUSH durable state first (work_items:checkpoint / loop:checkpoint / facts:assert) rather than relying on the cut. If you are still here on your next turn, it did not happen — re-request at the next clean stopping point instead of waiting."
          },
          "state": "queued",
          "statusAgrees": true,
          "accepted": true
        }
      ],
      "rejected": [],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null
    },
    {
      "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
      "request_id": "35086665",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a12387-82ae-7063-a36f-e1c3002e11c6",
          "callPart": 175,
          "resultPart": 176,
          "literalArgsEqual": true,
          "ledgerOwner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-10 02:46:15.345+00",
          "durationMs": 9418,
          "derivedDispatchStart": "2026-10-10T02:46:05.927Z",
          "callTimestamp": "2026-10-10T02:46:05.454+00:00",
          "responseTimestamp": "2026-10-10T02:46:17.251+00:00",
          "callBeforeDispatchMs": 473,
          "responseAfterSettleMs": 1906,
          "bounds": true,
          "noAmbiguity": true,
          "format": "toon",
          "textBlocks": 2,
          "body": {
            "ok": true,
            "requested": true,
            "respawn": "queued",
            "budgetChars": 331360,
            "firstPromptSource": "continuation-note",
            "staleCheckpoints": [],
            "openOwnerQuestion": false,
            "priorRespawn": {
              "outcome": "delivered",
              "ts": "2026-10-10T02:07:03.625Z",
              "ageMs": 2345900,
              "capMs": null
            },
            "note": "Carry-respawn QUEUED — not performed yet. The host cuts this process only once your pty goes QUIET at a clean boundary, then respawns your successor on the deterministic carry document. It re-polls for a few minutes and can terminally DROP the carry — an interactive back-and-forth, or steady output, can supersede it indefinitely. So: wrap up and go quiet now, but FLUSH durable state first (work_items:checkpoint / loop:checkpoint / facts:assert) rather than relying on the cut. If you are still here on your next turn, it did not happen — re-request at the next clean stopping point instead of waiting."
          },
          "state": "queued",
          "statusAgrees": true,
          "accepted": true
        }
      ],
      "rejected": [],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null
    },
    {
      "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
      "request_id": "35109557",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a123ce-3d90-7370-b895-0216719d6f67",
          "callPart": 136,
          "resultPart": 137,
          "literalArgsEqual": true,
          "ledgerOwner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-10 03:35:26.703+00",
          "durationMs": 3829,
          "derivedDispatchStart": "2026-10-10T03:35:22.874Z",
          "callTimestamp": "2026-10-10T03:35:22.304+00:00",
          "responseTimestamp": "2026-10-10T03:35:28.977+00:00",
          "callBeforeDispatchMs": 570,
          "responseAfterSettleMs": 2274,
          "bounds": true,
          "noAmbiguity": true,
          "format": "toon",
          "textBlocks": 2,
          "body": {
            "ok": true,
            "requested": true,
            "respawn": "queued",
            "budgetChars": 331360,
            "firstPromptSource": "continuation-note",
            "staleCheckpoints": [],
            "openOwnerQuestion": false,
            "priorRespawn": {
              "outcome": "delivered",
              "ts": "2026-10-10T03:15:21.083Z",
              "ageMs": 1205432,
              "capMs": null
            },
            "note": "Carry-respawn QUEUED — not performed yet. The host cuts this process only once your pty goes QUIET at a clean boundary, then respawns your successor on the deterministic carry document. It re-polls for a few minutes and can terminally DROP the carry — an interactive back-and-forth, or steady output, can supersede it indefinitely. So: wrap up and go quiet now, but FLUSH durable state first (work_items:checkpoint / loop:checkpoint / facts:assert) rather than relying on the cut. If you are still here on your next turn, it did not happen — re-request at the next clean stopping point instead of waiting."
          },
          "state": "queued",
          "statusAgrees": true,
          "accepted": true
        }
      ],
      "rejected": [],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null
    },
    {
      "owner": "su-1415d088-0af5-4299-a5df-8dbfc634335b",
      "request_id": "35284056",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a1252a-e133-7ba0-b5b4-28b9141acbb2",
          "callPart": 181,
          "resultPart": 182,
          "literalArgsEqual": true,
          "ledgerOwner": "su-1415d088-0af5-4299-a5df-8dbfc634335b",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-10 10:11:28.014+00",
          "durationMs": 7941,
          "derivedDispatchStart": "2026-10-10T10:11:20.073Z",
          "callTimestamp": "2026-10-10T10:11:19.628+00:00",
          "responseTimestamp": "2026-10-10T10:11:30.649+00:00",
          "callBeforeDispatchMs": 445,
          "responseAfterSettleMs": 2635,
          "bounds": true,
          "noAmbiguity": true,
          "format": "toon",
          "textBlocks": 2,
          "body": {
            "ok": true,
            "requested": true,
            "respawn": "queued",
            "budgetChars": 331360,
            "firstPromptSource": "continuation-note",
            "staleCheckpoints": [],
            "openOwnerQuestion": true,
            "priorRespawn": {
              "outcome": "pending",
              "reason": "busy-gate-expired",
              "ts": "2026-10-10T09:39:36.790Z",
              "ageMs": 1910160,
              "capMs": 360000
            },
            "note": "Carry-respawn QUEUED — not performed yet. The host cuts this process only once your pty goes QUIET at a clean boundary, then respawns your successor on the deterministic carry document. It re-polls for a few minutes and can terminally DROP the carry — an interactive back-and-forth, or steady output, can supersede it indefinitely. So: wrap up and go quiet now, but FLUSH durable state first (work_items:checkpoint / loop:checkpoint / facts:assert) rather than relying on the cut. If you are still here on your next turn, it did not happen — re-request at the next clean stopping point instead of waiting. ⚠ open-owner-question: your owner's final message looks UNANSWERED at this DELIBERATE boundary. It is NOT lost — it becomes your successor’s first prompt — but if you have room, answer it before you stop. ⚠ prior-respawn-DELAYED: an earlier carry-respawn on this session was queued 32m ago (host recorded `busy-gate-expired`) with no recorded terminal outcome. Its wait interval (360s) is not the request lifetime. The controller may still be retrying and may adopt this newer carry. Inspect its current state and verify the native continuation before inferring loss, delivery, or a new attempt. Keep flushing state durably rather than relying on the carry."
          },
          "state": "queued",
          "statusAgrees": true,
          "accepted": true
        }
      ],
      "rejected": [],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null
    },
    {
      "owner": "su-3067d842-6f5a-41ad-bada-9a47df0ea9a6",
      "request_id": "35002303",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a12305-f5aa-7263-8a97-999230d0e1b6",
          "callPart": 96,
          "resultPart": 97,
          "literalArgsEqual": true,
          "ledgerOwner": "su-3067d842-6f5a-41ad-bada-9a47df0ea9a6",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-09 23:50:46.285+00",
          "durationMs": 622,
          "derivedDispatchStart": "2026-10-09T23:50:45.663Z",
          "callTimestamp": "2026-10-09T23:50:45.465+00:00",
          "responseTimestamp": "2026-10-09T23:50:48.591+00:00",
          "callBeforeDispatchMs": 198,
          "responseAfterSettleMs": 2306,
          "bounds": true,
          "noAmbiguity": true,
          "format": "toon",
          "textBlocks": 2,
          "body": {
            "ok": true,
            "requested": true,
            "respawn": "queued",
            "budgetChars": 331360,
            "firstPromptSource": "continuation-note",
            "staleCheckpoints": [],
            "openOwnerQuestion": false,
            "priorRespawn": {
              "outcome": "pending",
              "reason": "busy-gate-expired",
              "ts": "2026-10-09T23:39:50.727Z",
              "ageMs": 655546,
              "capMs": 360000
            },
            "note": "Carry-respawn QUEUED — not performed yet. The host cuts this process only once your pty goes QUIET at a clean boundary, then respawns your successor on the deterministic carry document. It re-polls for a few minutes and can terminally DROP the carry — an interactive back-and-forth, or steady output, can supersede it indefinitely. So: wrap up and go quiet now, but FLUSH durable state first (work_items:checkpoint / loop:checkpoint / facts:assert) rather than relying on the cut. If you are still here on your next turn, it did not happen — re-request at the next clean stopping point instead of waiting. ⚠ prior-respawn-DELAYED: an earlier carry-respawn on this session was queued 11m ago (host recorded `busy-gate-expired`) with no recorded terminal outcome. Its wait interval (360s) is not the request lifetime. The controller may still be retrying and may adopt this newer carry. Inspect its current state and verify the native continuation before inferring loss, delivery, or a new attempt. Keep flushing state durably rather than relying on the carry."
          },
          "state": "queued",
          "statusAgrees": true,
          "accepted": true
        }
      ],
      "rejected": [],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null
    },
    {
      "owner": "su-3067d842-6f5a-41ad-bada-9a47df0ea9a6",
      "request_id": "35028001",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a12333-a7a7-7681-ac85-739741d5f755",
          "callPart": 160,
          "resultPart": 161,
          "literalArgsEqual": true,
          "ledgerOwner": "su-3067d842-6f5a-41ad-bada-9a47df0ea9a6",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-10 00:44:31.503+00",
          "durationMs": 648,
          "derivedDispatchStart": "2026-10-10T00:44:30.855Z",
          "callTimestamp": "2026-10-10T00:44:30.328+00:00",
          "responseTimestamp": "2026-10-10T00:44:31.888+00:00",
          "callBeforeDispatchMs": 527,
          "responseAfterSettleMs": 385,
          "bounds": true,
          "noAmbiguity": true,
          "format": "toon",
          "textBlocks": 2,
          "body": {
            "ok": true,
            "requested": true,
            "respawn": "queued",
            "budgetChars": 331360,
            "firstPromptSource": "continuation-note",
            "staleCheckpoints": [],
            "openOwnerQuestion": false,
            "priorRespawn": {
              "outcome": "delivered",
              "ts": "2026-10-10T00:26:24.848Z",
              "ageMs": 1086618,
              "capMs": null
            },
            "note": "Carry-respawn QUEUED — not performed yet. The host cuts this process only once your pty goes QUIET at a clean boundary, then respawns your successor on the deterministic carry document. It re-polls for a few minutes and can terminally DROP the carry — an interactive back-and-forth, or steady output, can supersede it indefinitely. So: wrap up and go quiet now, but FLUSH durable state first (work_items:checkpoint / loop:checkpoint / facts:assert) rather than relying on the cut. If you are still here on your next turn, it did not happen — re-request at the next clean stopping point instead of waiting."
          },
          "state": "queued",
          "statusAgrees": true,
          "accepted": true
        }
      ],
      "rejected": [],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null
    },
    {
      "owner": "su-3067d842-6f5a-41ad-bada-9a47df0ea9a6",
      "request_id": "35036424",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a12345-1b92-7182-852e-b520dc31a824",
          "callPart": 86,
          "resultPart": 87,
          "literalArgsEqual": true,
          "ledgerOwner": "su-3067d842-6f5a-41ad-bada-9a47df0ea9a6",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-10 01:00:19.687+00",
          "durationMs": 1246,
          "derivedDispatchStart": "2026-10-10T01:00:18.441Z",
          "callTimestamp": "2026-10-10T01:00:18.127+00:00",
          "responseTimestamp": "2026-10-10T01:00:20.089+00:00",
          "callBeforeDispatchMs": 314,
          "responseAfterSettleMs": 402,
          "bounds": true,
          "noAmbiguity": true,
          "format": "toon",
          "textBlocks": 2,
          "body": {
            "ok": true,
            "requested": true,
            "respawn": "queued",
            "budgetChars": 331360,
            "firstPromptSource": "continuation-note",
            "staleCheckpoints": [],
            "openOwnerQuestion": true,
            "priorRespawn": {
              "outcome": "delivered",
              "ts": "2026-10-10T00:45:20.710Z",
              "ageMs": 898934,
              "capMs": null
            },
            "note": "Carry-respawn QUEUED — not performed yet. The host cuts this process only once your pty goes QUIET at a clean boundary, then respawns your successor on the deterministic carry document. It re-polls for a few minutes and can terminally DROP the carry — an interactive back-and-forth, or steady output, can supersede it indefinitely. So: wrap up and go quiet now, but FLUSH durable state first (work_items:checkpoint / loop:checkpoint / facts:assert) rather than relying on the cut. If you are still here on your next turn, it did not happen — re-request at the next clean stopping point instead of waiting. ⚠ open-owner-question: your owner's final message looks UNANSWERED at this DELIBERATE boundary. It is NOT lost — it becomes your successor’s first prompt — but if you have room, answer it before you stop."
          },
          "state": "queued",
          "statusAgrees": true,
          "accepted": true
        }
      ],
      "rejected": [],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null
    },
    {
      "owner": "su-312c90f2-a3bd-4c92-ac4e-4eae40ae2647",
      "request_id": "35040409",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a1233a-0409-7e90-9a58-ad8018548b23",
          "callPart": 182,
          "resultPart": 183,
          "literalArgsEqual": true,
          "ledgerOwner": "su-312c90f2-a3bd-4c92-ac4e-4eae40ae2647",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-10 01:07:20.043+00",
          "durationMs": 1448,
          "derivedDispatchStart": "2026-10-10T01:07:18.595Z",
          "callTimestamp": "2026-10-10T01:07:18+00:00",
          "responseTimestamp": "2026-10-10T01:07:20.328+00:00",
          "callBeforeDispatchMs": 595,
          "responseAfterSettleMs": 285,
          "bounds": true,
          "noAmbiguity": true,
          "format": "toon",
          "textBlocks": 3,
          "body": {
            "ok": true,
            "requested": true,
            "respawn": "queued",
            "budgetChars": 331360,
            "firstPromptSource": "continuation-note",
            "staleCheckpoints": [],
            "openOwnerQuestion": false,
            "priorRespawn": {
              "outcome": "dropped",
              "reason": "successor-reanchor-unconfirmed",
              "ts": "2026-10-09T23:24:56.958Z",
              "ageMs": 6143027,
              "capMs": null
            },
            "note": "Carry-respawn QUEUED — not performed yet. The host cuts this process only once your pty goes QUIET at a clean boundary, then respawns your successor on the deterministic carry document. It re-polls for a few minutes and can terminally DROP the carry — an interactive back-and-forth, or steady output, can supersede it indefinitely. So: wrap up and go quiet now, but FLUSH durable state first (work_items:checkpoint / loop:checkpoint / facts:assert) rather than relying on the cut. If you are still here on your next turn, it did not happen — re-request at the next clean stopping point instead of waiting. ⚠ prior-respawn-DROPPED: your PREVIOUS carry continuation was not delivered — the host recorded `respawn-carry-dropped` (reason: successor-reanchor-unconfirmed) 2h ago. The successor process may already exist: spawning and submitting its first turn are separate steps. Verify the native continuation rather than the acknowledgement; keep flushing state durably (work_items:checkpoint / loop:checkpoint) rather than relying on the carry."
          },
          "state": "queued",
          "statusAgrees": true,
          "accepted": true
        }
      ],
      "rejected": [],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null
    },
    {
      "owner": "su-449b83a8-a709-43af-9681-768dc6ac744a",
      "request_id": "35030421",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a1233a-5367-7ba3-b8c3-97a25446ca0a",
          "callPart": 104,
          "resultPart": 105,
          "literalArgsEqual": true,
          "ledgerOwner": "su-449b83a8-a709-43af-9681-768dc6ac744a",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-10 00:48:31.351+00",
          "durationMs": 607,
          "derivedDispatchStart": "2026-10-10T00:48:30.744Z",
          "callTimestamp": "2026-10-10T00:48:30.393+00:00",
          "responseTimestamp": "2026-10-10T00:48:32.959+00:00",
          "callBeforeDispatchMs": 351,
          "responseAfterSettleMs": 1608,
          "bounds": true,
          "noAmbiguity": true,
          "format": "toon",
          "textBlocks": 2,
          "body": {
            "ok": true,
            "requested": true,
            "respawn": "queued",
            "budgetChars": 331360,
            "firstPromptSource": "continuation-note",
            "staleCheckpoints": [],
            "openOwnerQuestion": false,
            "priorRespawn": {
              "outcome": "delivered",
              "ts": "2026-10-10T00:33:34.037Z",
              "ageMs": 897285,
              "capMs": null
            },
            "note": "Carry-respawn QUEUED — not performed yet. The host cuts this process only once your pty goes QUIET at a clean boundary, then respawns your successor on the deterministic carry document. It re-polls for a few minutes and can terminally DROP the carry — an interactive back-and-forth, or steady output, can supersede it indefinitely. So: wrap up and go quiet now, but FLUSH durable state first (work_items:checkpoint / loop:checkpoint / facts:assert) rather than relying on the cut. If you are still here on your next turn, it did not happen — re-request at the next clean stopping point instead of waiting."
          },
          "state": "queued",
          "statusAgrees": true,
          "accepted": true
        }
      ],
      "rejected": [],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null
    },
    {
      "owner": "su-4adf5ebc-6443-4c3c-b704-162275765ff1",
      "request_id": "35342589",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a125b4-15cc-7d41-8499-3be49aaffbe1",
          "callPart": 113,
          "resultPart": 114,
          "literalArgsEqual": true,
          "ledgerOwner": "su-4adf5ebc-6443-4c3c-b704-162275765ff1",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-10 12:22:12.453+00",
          "durationMs": 672,
          "derivedDispatchStart": "2026-10-10T12:22:11.781Z",
          "callTimestamp": "2026-10-10T12:22:11.437+00:00",
          "responseTimestamp": "2026-10-10T12:22:12.739+00:00",
          "callBeforeDispatchMs": 344,
          "responseAfterSettleMs": 286,
          "bounds": true,
          "noAmbiguity": true,
          "format": "toon",
          "textBlocks": 2,
          "body": {
            "ok": true,
            "requested": true,
            "respawn": "queued",
            "budgetChars": 331360,
            "firstPromptSource": "continuation-note",
            "staleCheckpoints": [],
            "openOwnerQuestion": true,
            "priorRespawn": {
              "outcome": "dropped",
              "reason": "superseded",
              "ts": "2026-10-10T10:26:43.616Z",
              "ageMs": 6928801,
              "capMs": null
            },
            "note": "Carry-respawn QUEUED — not performed yet. The host cuts this process only once your pty goes QUIET at a clean boundary, then respawns your successor on the deterministic carry document. It re-polls for a few minutes and can terminally DROP the carry — an interactive back-and-forth, or steady output, can supersede it indefinitely. So: wrap up and go quiet now, but FLUSH durable state first (work_items:checkpoint / loop:checkpoint / facts:assert) rather than relying on the cut. If you are still here on your next turn, it did not happen — re-request at the next clean stopping point instead of waiting. ⚠ open-owner-question: 1 owner ask(s) remain OPEN in the conversation ledger at this DELIBERATE boundary. They are carried in the deterministic document; do not self-answer them after the respawn. ⚠ prior-respawn-DROPPED: your PREVIOUS carry continuation was not delivered — the host recorded `respawn-carry-dropped` (reason: superseded) 2h ago. The successor process may already exist: spawning and submitting its first turn are separate steps. Verify the native continuation rather than the acknowledgement; keep flushing state durably (work_items:checkpoint / loop:checkpoint) rather than relying on the carry."
          },
          "state": "queued",
          "statusAgrees": true,
          "accepted": true
        }
      ],
      "rejected": [],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null
    },
    {
      "owner": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
      "request_id": "34826106",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a121da-e5a4-75a1-bc1b-c2a446588a23",
          "callPart": 96,
          "resultPart": 97,
          "literalArgsEqual": true,
          "ledgerOwner": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-09 18:26:41.363+00",
          "durationMs": 4134,
          "derivedDispatchStart": "2026-10-09T18:26:37.229Z",
          "callTimestamp": "2026-10-09T18:26:36.52+00:00",
          "responseTimestamp": "2026-10-09T18:26:41.806+00:00",
          "callBeforeDispatchMs": 709,
          "responseAfterSettleMs": 443,
          "bounds": true,
          "noAmbiguity": true,
          "format": "toon",
          "textBlocks": 3,
          "body": {
            "ok": true,
            "requested": true,
            "respawn": "queued",
            "budgetChars": 331360,
            "firstPromptSource": "continuation-note",
            "staleCheckpoints": [],
            "openOwnerQuestion": false,
            "priorRespawn": {
              "outcome": "pending",
              "reason": "busy-gate-expired",
              "ts": "2026-10-09T18:12:48.523Z",
              "ageMs": 832619,
              "capMs": 360000
            },
            "note": "Carry-respawn QUEUED — not performed yet. The host cuts this process only once your pty goes QUIET at a clean boundary, then respawns your successor on the deterministic carry document. It re-polls for a few minutes and can terminally DROP the carry — an interactive back-and-forth, or steady output, can supersede it indefinitely. So: wrap up and go quiet now, but FLUSH durable state first (work_items:checkpoint / loop:checkpoint / facts:assert) rather than relying on the cut. If you are still here on your next turn, it did not happen — re-request at the next clean stopping point instead of waiting. ⚠ prior-respawn-DELAYED: an earlier carry-respawn on this session was queued 14m ago (host recorded `busy-gate-expired`) with no recorded terminal outcome. Its wait interval (360s) is not the request lifetime. The controller may still be retrying and may adopt this newer carry. Inspect its current state and verify the native continuation before inferring loss, delivery, or a new attempt. Keep flushing state durably rather than relying on the carry."
          },
          "state": "queued",
          "statusAgrees": true,
          "accepted": true
        }
      ],
      "rejected": [],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null
    },
    {
      "owner": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
      "request_id": "34975894",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a122cd-d7dd-78f0-88d9-88eb04565cbe",
          "callPart": 157,
          "resultPart": 158,
          "literalArgsEqual": true,
          "ledgerOwner": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-09 23:01:46.587+00",
          "durationMs": 620,
          "derivedDispatchStart": "2026-10-09T23:01:45.967Z",
          "callTimestamp": "2026-10-09T23:01:45.749+00:00",
          "responseTimestamp": "2026-10-09T23:01:48.009+00:00",
          "callBeforeDispatchMs": 218,
          "responseAfterSettleMs": 1422,
          "bounds": true,
          "noAmbiguity": true,
          "format": "toon",
          "textBlocks": 3,
          "body": {
            "ok": true,
            "requested": true,
            "respawn": "queued",
            "budgetChars": 331360,
            "firstPromptSource": "continuation-note",
            "staleCheckpoints": [],
            "openOwnerQuestion": false,
            "priorRespawn": {
              "outcome": "delivered",
              "ts": "2026-10-09T22:35:05.632Z",
              "ageMs": 1600925,
              "capMs": null
            },
            "note": "Carry-respawn QUEUED — not performed yet. The host cuts this process only once your pty goes QUIET at a clean boundary, then respawns your successor on the deterministic carry document. It re-polls for a few minutes and can terminally DROP the carry — an interactive back-and-forth, or steady output, can supersede it indefinitely. So: wrap up and go quiet now, but FLUSH durable state first (work_items:checkpoint / loop:checkpoint / facts:assert) rather than relying on the cut. If you are still here on your next turn, it did not happen — re-request at the next clean stopping point instead of waiting."
          },
          "state": "queued",
          "statusAgrees": true,
          "accepted": true
        }
      ],
      "rejected": [],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null
    },
    {
      "owner": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
      "request_id": "34988920",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a122e6-e50e-77c1-8895-9892175ba0e9",
          "callPart": 114,
          "resultPart": 115,
          "literalArgsEqual": true,
          "ledgerOwner": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-09 23:25:28.951+00",
          "durationMs": 613,
          "derivedDispatchStart": "2026-10-09T23:25:28.338Z",
          "callTimestamp": "2026-10-09T23:25:28.119+00:00",
          "responseTimestamp": "2026-10-09T23:25:29.206+00:00",
          "callBeforeDispatchMs": 219,
          "responseAfterSettleMs": 255,
          "bounds": true,
          "noAmbiguity": true,
          "format": "toon",
          "textBlocks": 2,
          "body": {
            "ok": true,
            "requested": true,
            "respawn": "queued",
            "budgetChars": 331360,
            "firstPromptSource": "continuation-note",
            "staleCheckpoints": [],
            "openOwnerQuestion": false,
            "priorRespawn": {
              "outcome": "delivered",
              "ts": "2026-10-09T23:02:25.922Z",
              "ageMs": 1382978,
              "capMs": null
            },
            "note": "Carry-respawn QUEUED — not performed yet. The host cuts this process only once your pty goes QUIET at a clean boundary, then respawns your successor on the deterministic carry document. It re-polls for a few minutes and can terminally DROP the carry — an interactive back-and-forth, or steady output, can supersede it indefinitely. So: wrap up and go quiet now, but FLUSH durable state first (work_items:checkpoint / loop:checkpoint / facts:assert) rather than relying on the cut. If you are still here on your next turn, it did not happen — re-request at the next clean stopping point instead of waiting."
          },
          "state": "queued",
          "statusAgrees": true,
          "accepted": true
        }
      ],
      "rejected": [],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null
    },
    {
      "owner": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
      "request_id": "35015509",
      "ledgerStatus": "ok",
      "candidates": 2,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a1231b-9a29-7b30-bb0e-4224ce54891a",
          "callPart": 168,
          "resultPart": 169,
          "literalArgsEqual": true,
          "ledgerOwner": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-10 00:18:58.68+00",
          "durationMs": 609,
          "derivedDispatchStart": "2026-10-10T00:18:58.071Z",
          "callTimestamp": "2026-10-10T00:18:57.861+00:00",
          "responseTimestamp": "2026-10-10T00:18:58.999+00:00",
          "callBeforeDispatchMs": 210,
          "responseAfterSettleMs": 319,
          "bounds": true,
          "noAmbiguity": true,
          "format": "toon",
          "textBlocks": 2,
          "body": {
            "ok": true,
            "requested": true,
            "respawn": "queued",
            "budgetChars": 331360,
            "firstPromptSource": "continuation-note",
            "staleCheckpoints": [],
            "openOwnerQuestion": false,
            "priorRespawn": {
              "outcome": "delivered",
              "ts": "2026-10-10T00:00:00.469Z",
              "ageMs": 1138186,
              "capMs": null
            },
            "note": "Carry-respawn QUEUED — not performed yet. The host cuts this process only once your pty goes QUIET at a clean boundary, then respawns your successor on the deterministic carry document. It re-polls for a few minutes and can terminally DROP the carry — an interactive back-and-forth, or steady output, can supersede it indefinitely. So: wrap up and go quiet now, but FLUSH durable state first (work_items:checkpoint / loop:checkpoint / facts:assert) rather than relying on the cut. If you are still here on your next turn, it did not happen — re-request at the next clean stopping point instead of waiting."
          },
          "state": "queued",
          "statusAgrees": true,
          "accepted": true
        }
      ],
      "rejected": [],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null
    },
    {
      "owner": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
      "request_id": "35020967",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a1232d-a990-7d60-bacf-7a5d4ed082fb",
          "callPart": 123,
          "resultPart": 124,
          "literalArgsEqual": true,
          "ledgerOwner": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-10 00:30:23.414+00",
          "durationMs": 777,
          "derivedDispatchStart": "2026-10-10T00:30:22.637Z",
          "callTimestamp": "2026-10-10T00:30:22.357+00:00",
          "responseTimestamp": "2026-10-10T00:30:25.035+00:00",
          "callBeforeDispatchMs": 280,
          "responseAfterSettleMs": 1621,
          "bounds": true,
          "noAmbiguity": true,
          "format": "toon",
          "textBlocks": 2,
          "body": {
            "ok": true,
            "requested": true,
            "respawn": "queued",
            "budgetChars": 331360,
            "firstPromptSource": "continuation-note",
            "staleCheckpoints": [],
            "openOwnerQuestion": false,
            "priorRespawn": {
              "outcome": "delivered",
              "ts": "2026-10-10T00:19:51.597Z",
              "ageMs": 631800,
              "capMs": null
            },
            "note": "Carry-respawn QUEUED — not performed yet. The host cuts this process only once your pty goes QUIET at a clean boundary, then respawns your successor on the deterministic carry document. It re-polls for a few minutes and can terminally DROP the carry — an interactive back-and-forth, or steady output, can supersede it indefinitely. So: wrap up and go quiet now, but FLUSH durable state first (work_items:checkpoint / loop:checkpoint / facts:assert) rather than relying on the cut. If you are still here on your next turn, it did not happen — re-request at the next clean stopping point instead of waiting."
          },
          "state": "queued",
          "statusAgrees": true,
          "accepted": true
        }
      ],
      "rejected": [],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null
    },
    {
      "owner": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
      "request_id": "35059682",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a12368-8531-7902-b76a-f5453e0f8474",
          "callPart": 136,
          "resultPart": 137,
          "literalArgsEqual": true,
          "ledgerOwner": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-10 01:45:43.638+00",
          "durationMs": 560,
          "derivedDispatchStart": "2026-10-10T01:45:43.078Z",
          "callTimestamp": "2026-10-10T01:45:42.847+00:00",
          "responseTimestamp": "2026-10-10T01:45:43.96+00:00",
          "callBeforeDispatchMs": 231,
          "responseAfterSettleMs": 322,
          "bounds": true,
          "noAmbiguity": true,
          "format": "toon",
          "textBlocks": null,
          "body": {
            "ok": true,
            "requested": true,
            "respawn": "queued",
            "budgetChars": 331360,
            "firstPromptSource": "continuation-note",
            "staleCheckpoints": [],
            "openOwnerQuestion": false,
            "priorRespawn": {
              "outcome": "delivered",
              "ts": "2026-10-10T01:23:41.757Z",
              "ageMs": 1321870,
              "capMs": null
            },
            "note": "Carry-respawn QUEUED — not performed yet. The host cuts this process only once your pty goes QUIET at a clean boundary, then respawns your successor on the deterministic carry document. It re-polls for a few minutes and can terminally DROP the carry — an interactive back-and-forth, or steady output, can supersede it indefinitely. So: wrap up and go quiet now, but FLUSH durable state first (work_items:checkpoint / loop:checkpoint / facts:assert) rather than relying on the cut. If you are still here on your next turn, it did not happen — re-request at the next clean stopping point instead of waiting.",
            "See also": "config:set-compaction-limit (tune when this fires)"
          },
          "state": "queued",
          "statusAgrees": true,
          "accepted": true
        }
      ],
      "rejected": [],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null
    },
    {
      "owner": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
      "request_id": "35060092",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a12368-8531-7902-b76a-f5453e0f8474",
          "callPart": 142,
          "resultPart": 143,
          "literalArgsEqual": true,
          "ledgerOwner": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-10 01:46:30.984+00",
          "durationMs": 663,
          "derivedDispatchStart": "2026-10-10T01:46:30.321Z",
          "callTimestamp": "2026-10-10T01:46:29.88+00:00",
          "responseTimestamp": "2026-10-10T01:46:31.448+00:00",
          "callBeforeDispatchMs": 441,
          "responseAfterSettleMs": 464,
          "bounds": true,
          "noAmbiguity": true,
          "format": "toon",
          "textBlocks": null,
          "body": {
            "ok": true,
            "requested": true,
            "respawn": "queued",
            "budgetChars": 331360,
            "firstPromptSource": "continuation-note",
            "staleCheckpoints": [],
            "openOwnerQuestion": false,
            "priorRespawn": {
              "outcome": "delivered",
              "ts": "2026-10-10T01:23:41.757Z",
              "ageMs": 1369214,
              "capMs": null
            },
            "note": "Carry-respawn QUEUED — not performed yet. The host cuts this process only once your pty goes QUIET at a clean boundary, then respawns your successor on the deterministic carry document. It re-polls for a few minutes and can terminally DROP the carry — an interactive back-and-forth, or steady output, can supersede it indefinitely. So: wrap up and go quiet now, but FLUSH durable state first (work_items:checkpoint / loop:checkpoint / facts:assert) rather than relying on the cut. If you are still here on your next turn, it did not happen — re-request at the next clean stopping point instead of waiting.",
            "See also": "config:set-compaction-limit (tune when this fires)"
          },
          "state": "queued",
          "statusAgrees": true,
          "accepted": true
        }
      ],
      "rejected": [],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null
    },
    {
      "owner": "su-82c46308-5eb9-4237-9d2d-950d322576c4",
      "request_id": "34951697",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a122a2-715a-7c80-87ec-c84aa8ee9391",
          "callPart": 102,
          "resultPart": 103,
          "literalArgsEqual": true,
          "ledgerOwner": "su-82c46308-5eb9-4237-9d2d-950d322576c4",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-09 22:10:59.546+00",
          "durationMs": 932,
          "derivedDispatchStart": "2026-10-09T22:10:58.614Z",
          "callTimestamp": "2026-10-09T22:10:58.161+00:00",
          "responseTimestamp": "2026-10-09T22:11:00.008+00:00",
          "callBeforeDispatchMs": 453,
          "responseAfterSettleMs": 462,
          "bounds": true,
          "noAmbiguity": true,
          "format": "toon",
          "textBlocks": 3,
          "body": {
            "ok": true,
            "requested": true,
            "respawn": "queued",
            "budgetChars": 331360,
            "firstPromptSource": "continuation-note",
            "staleCheckpoints": [],
            "openOwnerQuestion": false,
            "priorRespawn": {
              "outcome": "delivered",
              "ts": "2026-10-09T21:09:08.806Z",
              "ageMs": 3710719,
              "capMs": null
            },
            "note": "Carry-respawn QUEUED — not performed yet. The host cuts this process only once your pty goes QUIET at a clean boundary, then respawns your successor on the deterministic carry document. It re-polls for a few minutes and can terminally DROP the carry — an interactive back-and-forth, or steady output, can supersede it indefinitely. So: wrap up and go quiet now, but FLUSH durable state first (work_items:checkpoint / loop:checkpoint / facts:assert) rather than relying on the cut. If you are still here on your next turn, it did not happen — re-request at the next clean stopping point instead of waiting."
          },
          "state": "queued",
          "statusAgrees": true,
          "accepted": true
        }
      ],
      "rejected": [],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null
    },
    {
      "owner": "su-ab8cc07f-e903-4467-ac45-a32149258170",
      "request_id": "34817497",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a121c6-8c51-7341-9f03-314b22bd77e4",
          "callPart": 176,
          "resultPart": 177,
          "literalArgsEqual": true,
          "ledgerOwner": "su-ab8cc07f-e903-4467-ac45-a32149258170",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-09 18:11:36.733+00",
          "durationMs": 1050,
          "derivedDispatchStart": "2026-10-09T18:11:35.683Z",
          "callTimestamp": "2026-10-09T18:11:34.824+00:00",
          "responseTimestamp": "2026-10-09T18:11:36.907+00:00",
          "callBeforeDispatchMs": 859,
          "responseAfterSettleMs": 174,
          "bounds": true,
          "noAmbiguity": true,
          "format": "toon",
          "textBlocks": 2,
          "body": {
            "ok": true,
            "requested": true,
            "respawn": "queued",
            "budgetChars": 331360,
            "firstPromptSource": "continuation-note",
            "staleCheckpoints": [],
            "openOwnerQuestion": false,
            "priorRespawn": {
              "outcome": "delivered",
              "ts": "2026-10-09T17:47:37.425Z",
              "ageMs": 1439263,
              "capMs": null
            },
            "note": "Carry-respawn QUEUED — not performed yet. The host cuts this process only once your pty goes QUIET at a clean boundary, then respawns your successor on the deterministic carry document. It re-polls for a few minutes and can terminally DROP the carry — an interactive back-and-forth, or steady output, can supersede it indefinitely. So: wrap up and go quiet now, but FLUSH durable state first (work_items:checkpoint / loop:checkpoint / facts:assert) rather than relying on the cut. If you are still here on your next turn, it did not happen — re-request at the next clean stopping point instead of waiting."
          },
          "state": "queued",
          "statusAgrees": true,
          "accepted": true
        }
      ],
      "rejected": [],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null
    },
    {
      "owner": "su-ab8cc07f-e903-4467-ac45-a32149258170",
      "request_id": "35050968",
      "ledgerStatus": "ok",
      "candidates": 2,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a12360-da31-7753-8b52-6276d176e0d8",
          "callPart": 103,
          "resultPart": 104,
          "literalArgsEqual": true,
          "ledgerOwner": "su-ab8cc07f-e903-4467-ac45-a32149258170",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-10 01:28:48.821+00",
          "durationMs": 680,
          "derivedDispatchStart": "2026-10-10T01:28:48.141Z",
          "callTimestamp": "2026-10-10T01:28:47.905+00:00",
          "responseTimestamp": "2026-10-10T01:28:49.151+00:00",
          "callBeforeDispatchMs": 236,
          "responseAfterSettleMs": 330,
          "bounds": true,
          "noAmbiguity": true,
          "format": "toon",
          "textBlocks": null,
          "body": {
            "ok": true,
            "requested": true,
            "respawn": "queued",
            "budgetChars": 331360,
            "firstPromptSource": "continuation-note",
            "staleCheckpoints": [],
            "openOwnerQuestion": false,
            "priorRespawn": {
              "outcome": "delivered",
              "ts": "2026-10-10T01:15:24.651Z",
              "ageMs": 804127,
              "capMs": null
            },
            "note": "Carry-respawn QUEUED — not performed yet. The host cuts this process only once your pty goes QUIET at a clean boundary, then respawns your successor on the deterministic carry document. It re-polls for a few minutes and can terminally DROP the carry — an interactive back-and-forth, or steady output, can supersede it indefinitely. So: wrap up and go quiet now, but FLUSH durable state first (work_items:checkpoint / loop:checkpoint / facts:assert) rather than relying on the cut. If you are still here on your next turn, it did not happen — re-request at the next clean stopping point instead of waiting."
          },
          "state": "queued",
          "statusAgrees": true,
          "accepted": true
        }
      ],
      "rejected": [],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null
    },
    {
      "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
      "request_id": "34828463",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a121d3-5bd6-79d0-b0a0-ed2cca18cc7f",
          "callPart": 145,
          "resultPart": 146,
          "literalArgsEqual": true,
          "ledgerOwner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-09 18:30:38.971+00",
          "durationMs": 6957,
          "derivedDispatchStart": "2026-10-09T18:30:32.014Z",
          "callTimestamp": "2026-10-09T18:30:31.746+00:00",
          "responseTimestamp": "2026-10-09T18:30:44.424+00:00",
          "callBeforeDispatchMs": 268,
          "responseAfterSettleMs": 5453,
          "bounds": true,
          "noAmbiguity": true,
          "format": "toon",
          "textBlocks": 2,
          "body": {
            "ok": true,
            "requested": true,
            "respawn": "queued",
            "budgetChars": 331360,
            "firstPromptSource": "continuation-note",
            "staleCheckpoints": [],
            "openOwnerQuestion": false,
            "priorRespawn": {
              "outcome": "none"
            },
            "note": "Carry-respawn QUEUED — not performed yet. The host cuts this process only once your pty goes QUIET at a clean boundary, then respawns your successor on the deterministic carry document. It re-polls for a few minutes and can terminally DROP the carry — an interactive back-and-forth, or steady output, can supersede it indefinitely. So: wrap up and go quiet now, but FLUSH durable state first (work_items:checkpoint / loop:checkpoint / facts:assert) rather than relying on the cut. If you are still here on your next turn, it did not happen — re-request at the next clean stopping point instead of waiting."
          },
          "state": "queued",
          "statusAgrees": true,
          "accepted": true
        }
      ],
      "rejected": [],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null
    },
    {
      "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
      "request_id": "34941445",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a12299-6e21-74d3-8071-d47e5fd8490c",
          "callPart": 130,
          "resultPart": 131,
          "literalArgsEqual": true,
          "ledgerOwner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-09 21:53:51.826+00",
          "durationMs": 591,
          "derivedDispatchStart": "2026-10-09T21:53:51.235Z",
          "callTimestamp": "2026-10-09T21:53:50.949+00:00",
          "responseTimestamp": "2026-10-09T21:53:53.205+00:00",
          "callBeforeDispatchMs": 286,
          "responseAfterSettleMs": 1379,
          "bounds": true,
          "noAmbiguity": true,
          "format": "toon",
          "textBlocks": 2,
          "body": {
            "ok": true,
            "requested": true,
            "respawn": "queued",
            "budgetChars": 331360,
            "firstPromptSource": "continuation-note",
            "staleCheckpoints": [],
            "openOwnerQuestion": false,
            "priorRespawn": {
              "outcome": "delivered",
              "ts": "2026-10-09T21:37:50.048Z",
              "ageMs": 961764,
              "capMs": null
            },
            "note": "Carry-respawn QUEUED — not performed yet. The host cuts this process only once your pty goes QUIET at a clean boundary, then respawns your successor on the deterministic carry document. It re-polls for a few minutes and can terminally DROP the carry — an interactive back-and-forth, or steady output, can supersede it indefinitely. So: wrap up and go quiet now, but FLUSH durable state first (work_items:checkpoint / loop:checkpoint / facts:assert) rather than relying on the cut. If you are still here on your next turn, it did not happen — re-request at the next clean stopping point instead of waiting."
          },
          "state": "queued",
          "statusAgrees": true,
          "accepted": true
        }
      ],
      "rejected": [],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null
    },
    {
      "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
      "request_id": "34951995",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a122a8-bb6b-77a1-93fa-a6b691ae9157",
          "callPart": 116,
          "resultPart": 117,
          "literalArgsEqual": true,
          "ledgerOwner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-09 22:11:32.49+00",
          "durationMs": 664,
          "derivedDispatchStart": "2026-10-09T22:11:31.826Z",
          "callTimestamp": "2026-10-09T22:11:31.473+00:00",
          "responseTimestamp": "2026-10-09T22:11:32.71+00:00",
          "callBeforeDispatchMs": 353,
          "responseAfterSettleMs": 220,
          "bounds": true,
          "noAmbiguity": true,
          "format": "toon",
          "textBlocks": 2,
          "body": {
            "ok": true,
            "requested": true,
            "respawn": "queued",
            "budgetChars": 331360,
            "firstPromptSource": "continuation-note",
            "staleCheckpoints": [],
            "openOwnerQuestion": false,
            "priorRespawn": {
              "outcome": "delivered",
              "ts": "2026-10-09T21:54:32.128Z",
              "ageMs": 1020347,
              "capMs": null
            },
            "note": "Carry-respawn QUEUED — not performed yet. The host cuts this process only once your pty goes QUIET at a clean boundary, then respawns your successor on the deterministic carry document. It re-polls for a few minutes and can terminally DROP the carry — an interactive back-and-forth, or steady output, can supersede it indefinitely. So: wrap up and go quiet now, but FLUSH durable state first (work_items:checkpoint / loop:checkpoint / facts:assert) rather than relying on the cut. If you are still here on your next turn, it did not happen — re-request at the next clean stopping point instead of waiting."
          },
          "state": "queued",
          "statusAgrees": true,
          "accepted": true
        }
      ],
      "rejected": [],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null
    },
    {
      "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
      "request_id": "34980537",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a122d3-f5e7-7d62-bd7a-ffb4d0707a7d",
          "callPart": 234,
          "resultPart": 235,
          "literalArgsEqual": true,
          "ledgerOwner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-09 23:09:33.199+00",
          "durationMs": 700,
          "derivedDispatchStart": "2026-10-09T23:09:32.499Z",
          "callTimestamp": "2026-10-09T23:09:32.085+00:00",
          "responseTimestamp": "2026-10-09T23:09:34.838+00:00",
          "callBeforeDispatchMs": 414,
          "responseAfterSettleMs": 1639,
          "bounds": true,
          "noAmbiguity": true,
          "format": "toon",
          "textBlocks": 2,
          "body": {
            "ok": true,
            "requested": true,
            "respawn": "queued",
            "budgetChars": 331360,
            "firstPromptSource": "continuation-note",
            "staleCheckpoints": [],
            "openOwnerQuestion": true,
            "priorRespawn": {
              "outcome": "delivered",
              "ts": "2026-10-09T22:41:51.944Z",
              "ageMs": 1661241,
              "capMs": null
            },
            "note": "Carry-respawn QUEUED — not performed yet. The host cuts this process only once your pty goes QUIET at a clean boundary, then respawns your successor on the deterministic carry document. It re-polls for a few minutes and can terminally DROP the carry — an interactive back-and-forth, or steady output, can supersede it indefinitely. So: wrap up and go quiet now, but FLUSH durable state first (work_items:checkpoint / loop:checkpoint / facts:assert) rather than relying on the cut. If you are still here on your next turn, it did not happen — re-request at the next clean stopping point instead of waiting. ⚠ open-owner-question: your owner's final message looks UNANSWERED at this DELIBERATE boundary. It is NOT lost — it becomes your successor’s first prompt — but if you have room, answer it before you stop."
          },
          "state": "queued",
          "statusAgrees": true,
          "accepted": true
        }
      ],
      "rejected": [],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null
    },
    {
      "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
      "request_id": "35003363",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a12313-eb4f-7c40-af79-b54e337d5075",
          "callPart": 20,
          "resultPart": 21,
          "literalArgsEqual": true,
          "ledgerOwner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-09 23:52:48.874+00",
          "durationMs": 776,
          "derivedDispatchStart": "2026-10-09T23:52:48.098Z",
          "callTimestamp": "2026-10-09T23:52:47.823+00:00",
          "responseTimestamp": "2026-10-09T23:52:49.423+00:00",
          "callBeforeDispatchMs": 275,
          "responseAfterSettleMs": 549,
          "bounds": true,
          "noAmbiguity": true,
          "format": "toon",
          "textBlocks": 2,
          "body": {
            "ok": true,
            "requested": true,
            "respawn": "queued",
            "budgetChars": 331360,
            "firstPromptSource": "continuation-note",
            "staleCheckpoints": [],
            "openOwnerQuestion": false,
            "priorRespawn": {
              "outcome": "delivered",
              "ts": "2026-10-09T23:51:36.827Z",
              "ageMs": 71917,
              "capMs": null
            },
            "note": "Carry-respawn QUEUED — not performed yet. The host cuts this process only once your pty goes QUIET at a clean boundary, then respawns your successor on the deterministic carry document. It re-polls for a few minutes and can terminally DROP the carry — an interactive back-and-forth, or steady output, can supersede it indefinitely. So: wrap up and go quiet now, but FLUSH durable state first (work_items:checkpoint / loop:checkpoint / facts:assert) rather than relying on the cut. If you are still here on your next turn, it did not happen — re-request at the next clean stopping point instead of waiting."
          },
          "state": "queued",
          "statusAgrees": true,
          "accepted": true
        }
      ],
      "rejected": [],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null
    },
    {
      "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
      "request_id": "35050614",
      "ledgerStatus": "ok",
      "candidates": 2,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a12357-33fa-76b1-9add-840d4be15ec1",
          "callPart": 122,
          "resultPart": 123,
          "literalArgsEqual": true,
          "ledgerOwner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-10 01:28:19.074+00",
          "durationMs": 777,
          "derivedDispatchStart": "2026-10-10T01:28:18.297Z",
          "callTimestamp": "2026-10-10T01:28:18.007+00:00",
          "responseTimestamp": "2026-10-10T01:28:19.553+00:00",
          "callBeforeDispatchMs": 290,
          "responseAfterSettleMs": 479,
          "bounds": true,
          "noAmbiguity": true,
          "format": "toon",
          "textBlocks": 2,
          "body": {
            "ok": true,
            "requested": true,
            "respawn": "queued",
            "budgetChars": 331360,
            "firstPromptSource": "continuation-note",
            "staleCheckpoints": [],
            "openOwnerQuestion": false,
            "priorRespawn": {
              "outcome": "delivered",
              "ts": "2026-10-10T01:04:46.824Z",
              "ageMs": 1412228,
              "capMs": null
            },
            "note": "Carry-respawn QUEUED — not performed yet. The host cuts this process only once your pty goes QUIET at a clean boundary, then respawns your successor on the deterministic carry document. It re-polls for a few minutes and can terminally DROP the carry — an interactive back-and-forth, or steady output, can supersede it indefinitely. So: wrap up and go quiet now, but FLUSH durable state first (work_items:checkpoint / loop:checkpoint / facts:assert) rather than relying on the cut. If you are still here on your next turn, it did not happen — re-request at the next clean stopping point instead of waiting."
          },
          "state": "queued",
          "statusAgrees": true,
          "accepted": true
        }
      ],
      "rejected": [],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null
    },
    {
      "owner": "su-b7ae044b-c702-4275-8857-d8c0943bc6f6",
      "request_id": "35104998",
      "ledgerStatus": "ok",
      "candidates": 2,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a123cc-f94e-7762-904c-3a3fd9ed047f",
          "callPart": 101,
          "resultPart": 102,
          "literalArgsEqual": true,
          "ledgerOwner": "su-b7ae044b-c702-4275-8857-d8c0943bc6f6",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-10 03:23:32.184+00",
          "durationMs": 1338,
          "derivedDispatchStart": "2026-10-10T03:23:30.846Z",
          "callTimestamp": "2026-10-10T03:23:30.377+00:00",
          "responseTimestamp": "2026-10-10T03:23:33.82+00:00",
          "callBeforeDispatchMs": 469,
          "responseAfterSettleMs": 1636,
          "bounds": true,
          "noAmbiguity": true,
          "format": "toon",
          "textBlocks": 2,
          "body": {
            "ok": true,
            "requested": true,
            "respawn": "queued",
            "budgetChars": 331360,
            "firstPromptSource": "continuation-note",
            "staleCheckpoints": [],
            "openOwnerQuestion": false,
            "priorRespawn": {
              "outcome": "dropped",
              "reason": "successor-reanchor-unconfirmed",
              "ts": "2026-10-10T02:20:36.891Z",
              "ageMs": 3775272,
              "capMs": null
            },
            "note": "Carry-respawn QUEUED — not performed yet. The host cuts this process only once your pty goes QUIET at a clean boundary, then respawns your successor on the deterministic carry document. It re-polls for a few minutes and can terminally DROP the carry — an interactive back-and-forth, or steady output, can supersede it indefinitely. So: wrap up and go quiet now, but FLUSH durable state first (work_items:checkpoint / loop:checkpoint / facts:assert) rather than relying on the cut. If you are still here on your next turn, it did not happen — re-request at the next clean stopping point instead of waiting. ⚠ prior-respawn-DROPPED: your PREVIOUS carry continuation was not delivered — the host recorded `respawn-carry-dropped` (reason: successor-reanchor-unconfirmed) 63m ago. The successor process may already exist: spawning and submitting its first turn are separate steps. Verify the native continuation rather than the acknowledgement; keep flushing state durably (work_items:checkpoint / loop:checkpoint) rather than relying on the carry."
          },
          "state": "queued",
          "statusAgrees": true,
          "accepted": true
        }
      ],
      "rejected": [],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null
    },
    {
      "owner": "su-ba80f2f7-46f6-4aec-b99a-21e02460933f",
      "request_id": "34901238",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a12246-1d69-71f3-aa04-77e7f6c9aeda",
          "callPart": 177,
          "resultPart": 178,
          "literalArgsEqual": true,
          "ledgerOwner": "su-ba80f2f7-46f6-4aec-b99a-21e02460933f",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-09 20:41:07.843+00",
          "durationMs": 5974,
          "derivedDispatchStart": "2026-10-09T20:41:01.869Z",
          "callTimestamp": "2026-10-09T20:40:59.992+00:00",
          "responseTimestamp": "2026-10-09T20:41:13.05+00:00",
          "callBeforeDispatchMs": 1877,
          "responseAfterSettleMs": 5207,
          "bounds": true,
          "noAmbiguity": true,
          "format": "toon",
          "textBlocks": 2,
          "body": {
            "ok": true,
            "requested": true,
            "respawn": "queued",
            "budgetChars": 331360,
            "firstPromptSource": "continuation-note",
            "staleCheckpoints": [],
            "openOwnerQuestion": false,
            "priorRespawn": {
              "outcome": "none"
            },
            "note": "Carry-respawn QUEUED — not performed yet. The host cuts this process only once your pty goes QUIET at a clean boundary, then respawns your successor on the deterministic carry document. It re-polls for a few minutes and can terminally DROP the carry — an interactive back-and-forth, or steady output, can supersede it indefinitely. So: wrap up and go quiet now, but FLUSH durable state first (work_items:checkpoint / loop:checkpoint / facts:assert) rather than relying on the cut. If you are still here on your next turn, it did not happen — re-request at the next clean stopping point instead of waiting."
          },
          "state": "queued",
          "statusAgrees": true,
          "accepted": true
        }
      ],
      "rejected": [],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null
    },
    {
      "owner": "su-d88420f0-c0b4-4dc7-92c7-f60ab3ddab44",
      "request_id": "35217653",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a12498-129e-7420-ad23-b8c89cad3c5a",
          "callPart": 140,
          "resultPart": 141,
          "literalArgsEqual": true,
          "ledgerOwner": "su-d88420f0-c0b4-4dc7-92c7-f60ab3ddab44",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-10 07:37:54.22+00",
          "durationMs": 6022,
          "derivedDispatchStart": "2026-10-10T07:37:48.198Z",
          "callTimestamp": "2026-10-10T07:37:44.971+00:00",
          "responseTimestamp": "2026-10-10T07:37:55.902+00:00",
          "callBeforeDispatchMs": 3227,
          "responseAfterSettleMs": 1682,
          "bounds": true,
          "noAmbiguity": true,
          "format": "toon",
          "textBlocks": 2,
          "body": {
            "ok": true,
            "requested": true,
            "respawn": "queued",
            "budgetChars": 331360,
            "firstPromptSource": "continuation-note",
            "staleCheckpoints": [],
            "openOwnerQuestion": false,
            "priorRespawn": {
              "outcome": "delivered",
              "ts": "2026-10-10T06:55:36.142Z",
              "ageMs": 2537653,
              "capMs": null
            },
            "note": "Carry-respawn QUEUED — not performed yet. The host cuts this process only once your pty goes QUIET at a clean boundary, then respawns your successor on the deterministic carry document. It re-polls for a few minutes and can terminally DROP the carry — an interactive back-and-forth, or steady output, can supersede it indefinitely. So: wrap up and go quiet now, but FLUSH durable state first (work_items:checkpoint / loop:checkpoint / facts:assert) rather than relying on the cut. If you are still here on your next turn, it did not happen — re-request at the next clean stopping point instead of waiting."
          },
          "state": "queued",
          "statusAgrees": true,
          "accepted": true
        }
      ],
      "rejected": [],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null
    },
    {
      "owner": "su-d88420f0-c0b4-4dc7-92c7-f60ab3ddab44",
      "request_id": "35246481",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a124e1-9e74-7911-a07c-c48f1d4db388",
          "callPart": 152,
          "resultPart": 153,
          "literalArgsEqual": true,
          "ledgerOwner": "su-d88420f0-c0b4-4dc7-92c7-f60ab3ddab44",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-10 08:45:27.344+00",
          "durationMs": 7660,
          "derivedDispatchStart": "2026-10-10T08:45:19.684Z",
          "callTimestamp": "2026-10-10T08:45:17.566+00:00",
          "responseTimestamp": "2026-10-10T08:45:31.224+00:00",
          "callBeforeDispatchMs": 2118,
          "responseAfterSettleMs": 3880,
          "bounds": true,
          "noAmbiguity": true,
          "format": "toon",
          "textBlocks": 2,
          "body": {
            "ok": true,
            "requested": true,
            "respawn": "queued",
            "budgetChars": 331360,
            "firstPromptSource": "continuation-note",
            "staleCheckpoints": [],
            "openOwnerQuestion": false,
            "priorRespawn": {
              "outcome": "delivered",
              "ts": "2026-10-10T08:16:21.021Z",
              "ageMs": 1746066,
              "capMs": null
            },
            "note": "Carry-respawn QUEUED — not performed yet. The host cuts this process only once your pty goes QUIET at a clean boundary, then respawns your successor on the deterministic carry document. It re-polls for a few minutes and can terminally DROP the carry — an interactive back-and-forth, or steady output, can supersede it indefinitely. So: wrap up and go quiet now, but FLUSH durable state first (work_items:checkpoint / loop:checkpoint / facts:assert) rather than relying on the cut. If you are still here on your next turn, it did not happen — re-request at the next clean stopping point instead of waiting."
          },
          "state": "queued",
          "statusAgrees": true,
          "accepted": true
        }
      ],
      "rejected": [],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null
    },
    {
      "owner": "su-d88420f0-c0b4-4dc7-92c7-f60ab3ddab44",
      "request_id": "35271105",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a12517-0350-7a33-b327-d35d8394ea3a",
          "callPart": 135,
          "resultPart": 136,
          "literalArgsEqual": true,
          "ledgerOwner": "su-d88420f0-c0b4-4dc7-92c7-f60ab3ddab44",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-10 09:42:40.729+00",
          "durationMs": 5216,
          "derivedDispatchStart": "2026-10-10T09:42:35.513Z",
          "callTimestamp": "2026-10-10T09:42:33.374+00:00",
          "responseTimestamp": "2026-10-10T09:42:42.581+00:00",
          "callBeforeDispatchMs": 2139,
          "responseAfterSettleMs": 1852,
          "bounds": true,
          "noAmbiguity": true,
          "format": "toon",
          "textBlocks": 2,
          "body": {
            "ok": true,
            "requested": true,
            "respawn": "queued",
            "budgetChars": 331360,
            "firstPromptSource": "continuation-note",
            "staleCheckpoints": [],
            "openOwnerQuestion": false,
            "priorRespawn": {
              "outcome": "pending",
              "reason": "busy-gate-expired",
              "ts": "2026-10-10T09:21:20.552Z",
              "ageMs": 1280058,
              "capMs": 360000
            },
            "note": "Carry-respawn QUEUED — not performed yet. The host cuts this process only once your pty goes QUIET at a clean boundary, then respawns your successor on the deterministic carry document. It re-polls for a few minutes and can terminally DROP the carry — an interactive back-and-forth, or steady output, can supersede it indefinitely. So: wrap up and go quiet now, but FLUSH durable state first (work_items:checkpoint / loop:checkpoint / facts:assert) rather than relying on the cut. If you are still here on your next turn, it did not happen — re-request at the next clean stopping point instead of waiting. ⚠ prior-respawn-DELAYED: an earlier carry-respawn on this session was queued 21m ago (host recorded `busy-gate-expired`) with no recorded terminal outcome. Its wait interval (360s) is not the request lifetime. The controller may still be retrying and may adopt this newer carry. Inspect its current state and verify the native continuation before inferring loss, delivery, or a new attempt. Keep flushing state durably rather than relying on the carry."
          },
          "state": "queued",
          "statusAgrees": true,
          "accepted": true
        }
      ],
      "rejected": [],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null
    },
    {
      "owner": "su-ddb4cbf4-2581-4f7c-8d6a-efbb712bd295",
      "request_id": "34981473",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a122d7-8cb3-7563-92a2-4180bfbb7181",
          "callPart": 201,
          "resultPart": 202,
          "literalArgsEqual": true,
          "ledgerOwner": "su-ddb4cbf4-2581-4f7c-8d6a-efbb712bd295",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-09 23:11:26.589+00",
          "durationMs": 1628,
          "derivedDispatchStart": "2026-10-09T23:11:24.961Z",
          "callTimestamp": "2026-10-09T23:11:24.355+00:00",
          "responseTimestamp": "2026-10-09T23:11:30.908+00:00",
          "callBeforeDispatchMs": 606,
          "responseAfterSettleMs": 4319,
          "bounds": true,
          "noAmbiguity": true,
          "format": "toon",
          "textBlocks": 2,
          "body": {
            "ok": true,
            "requested": true,
            "respawn": "queued",
            "budgetChars": 331360,
            "firstPromptSource": "continuation-note",
            "staleCheckpoints": [],
            "openOwnerQuestion": true,
            "priorRespawn": {
              "outcome": "pending",
              "reason": "busy-gate-expired",
              "ts": "2026-10-09T22:48:48.191Z",
              "ageMs": 1357761,
              "capMs": 360000
            },
            "note": "Carry-respawn QUEUED — not performed yet. The host cuts this process only once your pty goes QUIET at a clean boundary, then respawns your successor on the deterministic carry document. It re-polls for a few minutes and can terminally DROP the carry — an interactive back-and-forth, or steady output, can supersede it indefinitely. So: wrap up and go quiet now, but FLUSH durable state first (work_items:checkpoint / loop:checkpoint / facts:assert) rather than relying on the cut. If you are still here on your next turn, it did not happen — re-request at the next clean stopping point instead of waiting. ⚠ open-owner-question: your owner's final message looks UNANSWERED at this DELIBERATE boundary. It is NOT lost — it becomes your successor’s first prompt — but if you have room, answer it before you stop. ⚠ prior-respawn-DELAYED: an earlier carry-respawn on this session was queued 23m ago (host recorded `busy-gate-expired`) with no recorded terminal outcome. Its wait interval (360s) is not the request lifetime. The controller may still be retrying and may adopt this newer carry. Inspect its current state and verify the native continuation before inferring loss, delivery, or a new attempt. Keep flushing state durably rather than relying on the carry."
          },
          "state": "queued",
          "statusAgrees": true,
          "accepted": true
        }
      ],
      "rejected": [],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null
    },
    {
      "owner": "su-ddb4cbf4-2581-4f7c-8d6a-efbb712bd295",
      "request_id": "34994869",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a122ef-e794-7141-ab72-5d02dedba04e",
          "callPart": 166,
          "resultPart": 167,
          "literalArgsEqual": true,
          "ledgerOwner": "su-ddb4cbf4-2581-4f7c-8d6a-efbb712bd295",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-09 23:36:26.49+00",
          "durationMs": 727,
          "derivedDispatchStart": "2026-10-09T23:36:25.763Z",
          "callTimestamp": "2026-10-09T23:36:25.47+00:00",
          "responseTimestamp": "2026-10-09T23:36:26.744+00:00",
          "callBeforeDispatchMs": 293,
          "responseAfterSettleMs": 254,
          "bounds": true,
          "noAmbiguity": true,
          "format": "toon",
          "textBlocks": 2,
          "body": {
            "ok": true,
            "requested": true,
            "respawn": "queued",
            "budgetChars": 331360,
            "firstPromptSource": "continuation-note",
            "staleCheckpoints": [],
            "openOwnerQuestion": true,
            "priorRespawn": {
              "outcome": "delivered",
              "ts": "2026-10-09T23:12:23.818Z",
              "ageMs": 1442655,
              "capMs": null
            },
            "note": "Carry-respawn QUEUED — not performed yet. The host cuts this process only once your pty goes QUIET at a clean boundary, then respawns your successor on the deterministic carry document. It re-polls for a few minutes and can terminally DROP the carry — an interactive back-and-forth, or steady output, can supersede it indefinitely. So: wrap up and go quiet now, but FLUSH durable state first (work_items:checkpoint / loop:checkpoint / facts:assert) rather than relying on the cut. If you are still here on your next turn, it did not happen — re-request at the next clean stopping point instead of waiting. ⚠ open-owner-question: your owner's final message looks UNANSWERED at this DELIBERATE boundary. It is NOT lost — it becomes your successor’s first prompt — but if you have room, answer it before you stop."
          },
          "state": "queued",
          "statusAgrees": true,
          "accepted": true
        }
      ],
      "rejected": [],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null
    },
    {
      "owner": "su-ddb4cbf4-2581-4f7c-8d6a-efbb712bd295",
      "request_id": "35021734",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a1232f-477f-7463-8b65-1c41196f6f7e",
          "callPart": 65,
          "resultPart": 66,
          "literalArgsEqual": true,
          "ledgerOwner": "su-ddb4cbf4-2581-4f7c-8d6a-efbb712bd295",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-10 00:31:47.054+00",
          "durationMs": 731,
          "derivedDispatchStart": "2026-10-10T00:31:46.323Z",
          "callTimestamp": "2026-10-10T00:31:46.096+00:00",
          "responseTimestamp": "2026-10-10T00:31:48.681+00:00",
          "callBeforeDispatchMs": 227,
          "responseAfterSettleMs": 1627,
          "bounds": true,
          "noAmbiguity": true,
          "format": "toon",
          "textBlocks": 2,
          "body": {
            "ok": true,
            "requested": true,
            "respawn": "queued",
            "budgetChars": 331360,
            "firstPromptSource": "continuation-note",
            "staleCheckpoints": [],
            "openOwnerQuestion": false,
            "priorRespawn": {
              "outcome": "delivered",
              "ts": "2026-10-10T00:21:30.470Z",
              "ageMs": 616561,
              "capMs": null
            },
            "note": "Carry-respawn QUEUED — not performed yet. The host cuts this process only once your pty goes QUIET at a clean boundary, then respawns your successor on the deterministic carry document. It re-polls for a few minutes and can terminally DROP the carry — an interactive back-and-forth, or steady output, can supersede it indefinitely. So: wrap up and go quiet now, but FLUSH durable state first (work_items:checkpoint / loop:checkpoint / facts:assert) rather than relying on the cut. If you are still here on your next turn, it did not happen — re-request at the next clean stopping point instead of waiting."
          },
          "state": "queued",
          "statusAgrees": true,
          "accepted": true
        }
      ],
      "rejected": [],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null
    },
    {
      "owner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
      "request_id": "32205045",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a11110-5644-7cd1-ae08-0fa1ab812d13",
          "callPart": 122,
          "resultPart": 123,
          "literalArgsEqual": true,
          "ledgerOwner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-06 12:22:44.955+00",
          "durationMs": 7451,
          "derivedDispatchStart": "2026-10-06T12:22:37.504Z",
          "callTimestamp": "2026-10-06T12:22:36.791+00:00",
          "responseTimestamp": "2026-10-06T12:22:50.49+00:00",
          "callBeforeDispatchMs": 713,
          "responseAfterSettleMs": 5535,
          "bounds": true,
          "noAmbiguity": true,
          "format": "toon",
          "textBlocks": 2,
          "body": {
            "ok": true,
            "requested": true,
            "respawn": "queued",
            "budgetChars": 331360,
            "firstPromptSource": "continuation-note",
            "staleCheckpoints": [],
            "openOwnerQuestion": false,
            "priorRespawn": {
              "outcome": "pending",
              "reason": "superseded-pending-rearm",
              "ts": "2026-10-06T12:22:13.788Z",
              "ageMs": 30908,
              "capMs": 180000
            },
            "note": "Carry-respawn QUEUED — not performed yet. The host cuts this process only once your pty goes QUIET at a clean boundary, then respawns your successor on the deterministic carry document. It re-polls for a few minutes and can terminally DROP the carry — an interactive back-and-forth, or steady output, can supersede it indefinitely. So: wrap up and go quiet now, but FLUSH durable state first (work_items:checkpoint / loop:checkpoint / facts:assert) rather than relying on the cut. If you are still here on your next turn, it did not happen — re-request at the next clean stopping point instead of waiting. ⚠ prior-respawn-STILL-PENDING: an earlier carry-respawn is still awaiting its cut or first-turn delivery (host recorded `superseded-pending-rearm` just now). This request SUPERSEDES it — the in-flight re-poll adopts this newer carry document — but the cut still only fires once your pty actually goes quiet."
          },
          "state": "queued",
          "statusAgrees": true,
          "accepted": true
        }
      ],
      "rejected": [],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null
    },
    {
      "owner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
      "request_id": "32327156",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a1121c-4101-7c63-af3e-ef84388e3bbb",
          "callPart": 155,
          "resultPart": 156,
          "literalArgsEqual": true,
          "ledgerOwner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-06 17:17:20.335+00",
          "durationMs": 614,
          "derivedDispatchStart": "2026-10-06T17:17:19.721Z",
          "callTimestamp": "2026-10-06T17:17:19.526+00:00",
          "responseTimestamp": "2026-10-06T17:17:20.899+00:00",
          "callBeforeDispatchMs": 195,
          "responseAfterSettleMs": 564,
          "bounds": true,
          "noAmbiguity": true,
          "format": "toon",
          "textBlocks": 2,
          "body": {
            "ok": true,
            "requested": true,
            "respawn": "queued",
            "budgetChars": 331360,
            "firstPromptSource": "continuation-note",
            "staleCheckpoints": [],
            "openOwnerQuestion": false,
            "priorRespawn": {
              "outcome": "pending",
              "reason": "superseded-pending-rearm",
              "ts": "2026-10-06T16:59:01.666Z",
              "ageMs": 1098658,
              "capMs": 180000
            },
            "note": "Carry-respawn QUEUED — not performed yet. The host cuts this process only once your pty goes QUIET at a clean boundary, then respawns your successor on the deterministic carry document. It re-polls for a few minutes and can terminally DROP the carry — an interactive back-and-forth, or steady output, can supersede it indefinitely. So: wrap up and go quiet now, but FLUSH durable state first (work_items:checkpoint / loop:checkpoint / facts:assert) rather than relying on the cut. If you are still here on your next turn, it did not happen — re-request at the next clean stopping point instead of waiting. ⚠ prior-respawn-DELAYED: an earlier carry-respawn on this session was queued 18m ago (host recorded `superseded-pending-rearm`) with no recorded terminal outcome. Its wait interval (180s) is not the request lifetime. The controller may still be retrying and may adopt this newer carry. Inspect its current state and verify the native continuation before inferring loss, delivery, or a new attempt. Keep flushing state durably rather than relying on the carry."
          },
          "state": "queued",
          "statusAgrees": true,
          "accepted": true
        }
      ],
      "rejected": [],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null
    },
    {
      "owner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
      "request_id": "34964960",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a122c4-d57d-7641-9c12-39444b89f809",
          "callPart": 100,
          "resultPart": 101,
          "literalArgsEqual": true,
          "ledgerOwner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-09 22:38:32.257+00",
          "durationMs": 680,
          "derivedDispatchStart": "2026-10-09T22:38:31.577Z",
          "callTimestamp": "2026-10-09T22:38:31.314+00:00",
          "responseTimestamp": "2026-10-09T22:38:44.783+00:00",
          "callBeforeDispatchMs": 263,
          "responseAfterSettleMs": 12526,
          "bounds": true,
          "noAmbiguity": true,
          "format": "toon",
          "textBlocks": 2,
          "body": {
            "ok": true,
            "requested": true,
            "respawn": "queued",
            "budgetChars": 331360,
            "firstPromptSource": "continuation-note",
            "staleCheckpoints": [],
            "openOwnerQuestion": false,
            "priorRespawn": {
              "outcome": "delivered",
              "ts": "2026-10-09T21:46:58.926Z",
              "ageMs": 3093302,
              "capMs": null
            },
            "note": "Carry-respawn QUEUED — not performed yet. The host cuts this process only once your pty goes QUIET at a clean boundary, then respawns your successor on the deterministic carry document. It re-polls for a few minutes and can terminally DROP the carry — an interactive back-and-forth, or steady output, can supersede it indefinitely. So: wrap up and go quiet now, but FLUSH durable state first (work_items:checkpoint / loop:checkpoint / facts:assert) rather than relying on the cut. If you are still here on your next turn, it did not happen — re-request at the next clean stopping point instead of waiting."
          },
          "state": "queued",
          "statusAgrees": true,
          "accepted": true
        }
      ],
      "rejected": [],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null
    },
    {
      "owner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
      "request_id": "34995729",
      "ledgerStatus": "ok",
      "candidates": 2,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a122f9-79ba-7103-822b-a12fb9cf4bc2",
          "callPart": 107,
          "resultPart": 108,
          "literalArgsEqual": true,
          "ledgerOwner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-09 23:38:02.064+00",
          "durationMs": 599,
          "derivedDispatchStart": "2026-10-09T23:38:01.465Z",
          "callTimestamp": "2026-10-09T23:38:01.256+00:00",
          "responseTimestamp": "2026-10-09T23:38:02.401+00:00",
          "callBeforeDispatchMs": 209,
          "responseAfterSettleMs": 337,
          "bounds": true,
          "noAmbiguity": true,
          "format": "toon",
          "textBlocks": 2,
          "body": {
            "ok": true,
            "requested": true,
            "respawn": "queued",
            "budgetChars": 331360,
            "firstPromptSource": "continuation-note",
            "staleCheckpoints": [],
            "openOwnerQuestion": false,
            "priorRespawn": {
              "outcome": "delivered",
              "ts": "2026-10-09T23:22:23.626Z",
              "ageMs": 938421,
              "capMs": null
            },
            "note": "Carry-respawn QUEUED — not performed yet. The host cuts this process only once your pty goes QUIET at a clean boundary, then respawns your successor on the deterministic carry document. It re-polls for a few minutes and can terminally DROP the carry — an interactive back-and-forth, or steady output, can supersede it indefinitely. So: wrap up and go quiet now, but FLUSH durable state first (work_items:checkpoint / loop:checkpoint / facts:assert) rather than relying on the cut. If you are still here on your next turn, it did not happen — re-request at the next clean stopping point instead of waiting."
          },
          "state": "queued",
          "statusAgrees": true,
          "accepted": true
        }
      ],
      "rejected": [],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null
    },
    {
      "owner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
      "request_id": "35035804",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a12342-ad02-7c12-9677-7f6401fadfbc",
          "callPart": 148,
          "resultPart": 149,
          "literalArgsEqual": true,
          "ledgerOwner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-10 00:59:05.49+00",
          "durationMs": 1495,
          "derivedDispatchStart": "2026-10-10T00:59:03.995Z",
          "callTimestamp": "2026-10-10T00:59:03.14+00:00",
          "responseTimestamp": "2026-10-10T00:59:05.731+00:00",
          "callBeforeDispatchMs": 855,
          "responseAfterSettleMs": 241,
          "bounds": true,
          "noAmbiguity": true,
          "format": "toon",
          "textBlocks": 2,
          "body": {
            "ok": true,
            "requested": true,
            "respawn": "queued",
            "budgetChars": 331360,
            "firstPromptSource": "continuation-note",
            "staleCheckpoints": [],
            "openOwnerQuestion": false,
            "priorRespawn": {
              "outcome": "delivered",
              "ts": "2026-10-10T00:42:41.645Z",
              "ageMs": 983798,
              "capMs": null
            },
            "note": "Carry-respawn QUEUED — not performed yet. The host cuts this process only once your pty goes QUIET at a clean boundary, then respawns your successor on the deterministic carry document. It re-polls for a few minutes and can terminally DROP the carry — an interactive back-and-forth, or steady output, can supersede it indefinitely. So: wrap up and go quiet now, but FLUSH durable state first (work_items:checkpoint / loop:checkpoint / facts:assert) rather than relying on the cut. If you are still here on your next turn, it did not happen — re-request at the next clean stopping point instead of waiting."
          },
          "state": "queued",
          "statusAgrees": true,
          "accepted": true
        }
      ],
      "rejected": [],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null
    },
    {
      "owner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
      "request_id": "35046373",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a12352-48ef-7a32-b5d6-001dc022af23",
          "callPart": 114,
          "resultPart": 115,
          "literalArgsEqual": true,
          "ledgerOwner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-10 01:20:21.639+00",
          "durationMs": 936,
          "derivedDispatchStart": "2026-10-10T01:20:20.703Z",
          "callTimestamp": "2026-10-10T01:20:20.487+00:00",
          "responseTimestamp": "2026-10-10T01:20:23.045+00:00",
          "callBeforeDispatchMs": 216,
          "responseAfterSettleMs": 1406,
          "bounds": true,
          "noAmbiguity": true,
          "format": "toon",
          "textBlocks": 2,
          "body": {
            "ok": true,
            "requested": true,
            "respawn": "queued",
            "budgetChars": 331360,
            "firstPromptSource": "continuation-note",
            "staleCheckpoints": [],
            "openOwnerQuestion": false,
            "priorRespawn": {
              "outcome": "delivered",
              "ts": "2026-10-10T00:59:24.016Z",
              "ageMs": 1257521,
              "capMs": null
            },
            "note": "Carry-respawn QUEUED — not performed yet. The host cuts this process only once your pty goes QUIET at a clean boundary, then respawns your successor on the deterministic carry document. It re-polls for a few minutes and can terminally DROP the carry — an interactive back-and-forth, or steady output, can supersede it indefinitely. So: wrap up and go quiet now, but FLUSH durable state first (work_items:checkpoint / loop:checkpoint / facts:assert) rather than relying on the cut. If you are still here on your next turn, it did not happen — re-request at the next clean stopping point instead of waiting."
          },
          "state": "queued",
          "statusAgrees": true,
          "accepted": true
        }
      ],
      "rejected": [],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null
    },
    {
      "owner": "su-f6b6fcca-f4f9-484f-86ca-974378824a67",
      "request_id": "35099069",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a122fa-d902-77e3-9bf0-4d450b2086f2",
          "callPart": 140,
          "resultPart": 141,
          "literalArgsEqual": true,
          "ledgerOwner": "su-f6b6fcca-f4f9-484f-86ca-974378824a67",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-10 03:11:26.131+00",
          "durationMs": 6251,
          "derivedDispatchStart": "2026-10-10T03:11:19.880Z",
          "callTimestamp": "2026-10-10T03:11:18.404+00:00",
          "responseTimestamp": "2026-10-10T03:11:27.781+00:00",
          "callBeforeDispatchMs": 1476,
          "responseAfterSettleMs": 1650,
          "bounds": true,
          "noAmbiguity": true,
          "format": "toon",
          "textBlocks": 2,
          "body": {
            "ok": true,
            "requested": true,
            "respawn": "queued",
            "budgetChars": 331360,
            "firstPromptSource": "continuation-note",
            "staleCheckpoints": [],
            "openOwnerQuestion": false,
            "priorRespawn": {
              "outcome": "delivered",
              "ts": "2026-10-09T23:23:55.176Z",
              "ageMs": 13645368,
              "capMs": null
            },
            "note": "Carry-respawn QUEUED — not performed yet. The host cuts this process only once your pty goes QUIET at a clean boundary, then respawns your successor on the deterministic carry document. It re-polls for a few minutes and can terminally DROP the carry — an interactive back-and-forth, or steady output, can supersede it indefinitely. So: wrap up and go quiet now, but FLUSH durable state first (work_items:checkpoint / loop:checkpoint / facts:assert) rather than relying on the cut. If you are still here on your next turn, it did not happen — re-request at the next clean stopping point instead of waiting."
          },
          "state": "queued",
          "statusAgrees": true,
          "accepted": true
        }
      ],
      "rejected": [],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null
    },
    {
      "owner": "su-f6e9cbee-faee-465e-9281-2743f85a91ab",
      "request_id": "35096877",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a123b8-2a5c-74e1-b654-b4b7df566a9e",
          "callPart": 86,
          "resultPart": 87,
          "literalArgsEqual": true,
          "ledgerOwner": "su-f6e9cbee-faee-465e-9281-2743f85a91ab",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-10 03:07:21.967+00",
          "durationMs": 846,
          "derivedDispatchStart": "2026-10-10T03:07:21.121Z",
          "callTimestamp": "2026-10-10T03:07:20.856+00:00",
          "responseTimestamp": "2026-10-10T03:07:23.648+00:00",
          "callBeforeDispatchMs": 265,
          "responseAfterSettleMs": 1681,
          "bounds": true,
          "noAmbiguity": true,
          "format": "toon",
          "textBlocks": null,
          "body": {
            "ok": true,
            "requested": true,
            "respawn": "queued",
            "budgetChars": 331360,
            "firstPromptSource": "continuation-note",
            "staleCheckpoints": [],
            "openOwnerQuestion": false,
            "priorRespawn": {
              "outcome": "dropped",
              "reason": "superseded",
              "ts": "2026-10-09T21:50:57.346Z",
              "ageMs": 18984600,
              "capMs": null
            },
            "note": "Carry-respawn QUEUED — not performed yet. The host cuts this process only once your pty goes QUIET at a clean boundary, then respawns your successor on the deterministic carry document. It re-polls for a few minutes and can terminally DROP the carry — an interactive back-and-forth, or steady output, can supersede it indefinitely. So: wrap up and go quiet now, but FLUSH durable state first (work_items:checkpoint / loop:checkpoint / facts:assert) rather than relying on the cut. If you are still here on your next turn, it did not happen — re-request at the next clean stopping point instead of waiting. ⚠ prior-respawn-DROPPED: your PREVIOUS carry continuation was not delivered — the host recorded `respawn-carry-dropped` (reason: superseded) 5h ago. The successor process may already exist: spawning and submitting its first turn are separate steps. Verify the native continuation rather than the acknowledgement; keep flushing state durably (work_items:checkpoint / loop:checkpoint) rather than relying on the carry.",
            "See also": "config:set-compaction-limit (tune when this fires)"
          },
          "state": "queued",
          "statusAgrees": true,
          "accepted": true
        }
      ],
      "rejected": [],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null
    },
    {
      "owner": "su-faf26552-0633-4081-a250-172c02f07c19",
      "request_id": "35093983",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a123a4-5fa4-7ce2-be09-ab21836e7b27",
          "callPart": 155,
          "resultPart": 156,
          "literalArgsEqual": true,
          "ledgerOwner": "su-faf26552-0633-4081-a250-172c02f07c19",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-10 03:02:12.503+00",
          "durationMs": 6259,
          "derivedDispatchStart": "2026-10-10T03:02:06.244Z",
          "callTimestamp": "2026-10-10T03:02:03.902+00:00",
          "responseTimestamp": "2026-10-10T03:02:14.7+00:00",
          "callBeforeDispatchMs": 2342,
          "responseAfterSettleMs": 2197,
          "bounds": true,
          "noAmbiguity": true,
          "format": "toon",
          "textBlocks": 2,
          "body": {
            "ok": true,
            "requested": true,
            "respawn": "queued",
            "budgetChars": 331360,
            "firstPromptSource": "continuation-note",
            "staleCheckpoints": [],
            "openOwnerQuestion": false,
            "priorRespawn": {
              "outcome": "delivered",
              "ts": "2026-10-10T02:33:37.484Z",
              "ageMs": 1714662,
              "capMs": null
            },
            "note": "Carry-respawn QUEUED — not performed yet. The host cuts this process only once your pty goes QUIET at a clean boundary, then respawns your successor on the deterministic carry document. It re-polls for a few minutes and can terminally DROP the carry — an interactive back-and-forth, or steady output, can supersede it indefinitely. So: wrap up and go quiet now, but FLUSH durable state first (work_items:checkpoint / loop:checkpoint / facts:assert) rather than relying on the cut. If you are still here on your next turn, it did not happen — re-request at the next clean stopping point instead of waiting."
          },
          "state": "queued",
          "statusAgrees": true,
          "accepted": true
        }
      ],
      "rejected": [],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null
    },
    {
      "owner": "su-faf26552-0633-4081-a250-172c02f07c19",
      "request_id": "35103184",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a123c3-011a-7f41-9501-be4014cfbaaf",
          "callPart": 85,
          "resultPart": 86,
          "literalArgsEqual": true,
          "ledgerOwner": "su-faf26552-0633-4081-a250-172c02f07c19",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-10 03:19:29.336+00",
          "durationMs": 2666,
          "derivedDispatchStart": "2026-10-10T03:19:26.670Z",
          "callTimestamp": "2026-10-10T03:19:25.856+00:00",
          "responseTimestamp": "2026-10-10T03:19:29.86+00:00",
          "callBeforeDispatchMs": 814,
          "responseAfterSettleMs": 524,
          "bounds": true,
          "noAmbiguity": true,
          "format": "toon",
          "textBlocks": 3,
          "body": {
            "ok": true,
            "requested": true,
            "respawn": "queued",
            "budgetChars": 331360,
            "firstPromptSource": "continuation-note",
            "staleCheckpoints": [],
            "openOwnerQuestion": false,
            "priorRespawn": {
              "outcome": "pending",
              "reason": "superseded-pending-rearm",
              "ts": "2026-10-10T03:11:56.869Z",
              "ageMs": 452328,
              "capMs": 180000
            },
            "note": "Carry-respawn QUEUED — not performed yet. The host cuts this process only once your pty goes QUIET at a clean boundary, then respawns your successor on the deterministic carry document. It re-polls for a few minutes and can terminally DROP the carry — an interactive back-and-forth, or steady output, can supersede it indefinitely. So: wrap up and go quiet now, but FLUSH durable state first (work_items:checkpoint / loop:checkpoint / facts:assert) rather than relying on the cut. If you are still here on your next turn, it did not happen — re-request at the next clean stopping point instead of waiting. ⚠ prior-respawn-DELAYED: an earlier carry-respawn on this session was queued 8m ago (host recorded `superseded-pending-rearm`) with no recorded terminal outcome. Its wait interval (180s) is not the request lifetime. The controller may still be retrying and may adopt this newer carry. Inspect its current state and verify the native continuation before inferring loss, delivery, or a new attempt. Keep flushing state durably rather than relying on the carry."
          },
          "state": "queued",
          "statusAgrees": true,
          "accepted": true
        }
      ],
      "rejected": [],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null
    },
    {
      "owner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
      "request_id": "32189831",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 0,
      "pairs": [
        {
          "nativeSession": "01a110de-da18-77a1-ae59-266572a9581f",
          "callPart": 176,
          "resultPart": 179,
          "callTimestamp": "2026-10-06 11:52:36.944+00",
          "responseTimestamp": "2026-10-06 07:53:28.981-04",
          "mechanisms": [
            "ptool-quoted-json"
          ],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "68",
            "yieldPart": 177,
            "waitPart": 178,
            "originalCallPart": 176
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
          "completeOriginalPair": true,
          "accepted": true,
          "state": "queued"
        }
      ],
      "rejected": [],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null,
      "priorAssessment": {
        "owner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
        "request_id": "32189831",
        "ledgerStatus": "ok",
        "candidates": 1,
        "exactArgumentMatches": 0,
        "pairs": [],
        "rejected": [],
        "receiptState": "unresolved",
        "acceptedUnique": false,
        "reason": "no-accepted-complete-pair"
      },
      "custodySource": "audits/parked-agent-resumption-2026-10-09/r13-cold23-five-original-custody-424d5.json",
      "currentSourceAssessment": {
        "request_id": "32189831",
        "owner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
        "completeOriginalPair": true,
        "pairs": [
          {
            "nativeSession": "01a110de-da18-77a1-ae59-266572a9581f",
            "callPart": 176,
            "resultPart": 179,
            "callTimestamp": "2026-10-06 11:52:36.944+00",
            "responseTimestamp": "2026-10-06 07:53:28.981-04",
            "mechanisms": [
              "ptool-quoted-json"
            ],
            "conditionalAlternatives": false,
            "chain": {
              "cellId": "68",
              "yieldPart": 177,
              "waitPart": 178,
              "originalCallPart": 176
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
      }
    },
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
      "outcomeJoined": false,
      "assessmentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch1-424d5.json",
      "instrumentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold25-native-analysis-instrument-424d5.json"
    },
    {
      "request_id": "32231391",
      "owner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
      "completeOriginalPair": true,
      "pairs": [
        {
          "nativeSession": "01a1113e-65dd-7822-9033-cde625ea52e3",
          "callPart": 4,
          "resultPart": 5,
          "callTimestamp": "2026-10-06T12:44:51.946Z",
          "responseTimestamp": "2026-10-06T12:44:52.655Z",
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
          "nativeSession": "01a1113e-65dd-7822-9033-cde625ea52e3",
          "callPart": 6,
          "resultPart": 7,
          "callTimestamp": "2026-10-06T12:45:18.521Z",
          "responseTimestamp": "2026-10-06T12:45:18.599Z",
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
          "nativeSession": "01a1113e-65dd-7822-9033-cde625ea52e3",
          "callPart": 8,
          "resultPart": 9,
          "callTimestamp": "2026-10-06T12:45:36.036Z",
          "responseTimestamp": "2026-10-06T12:45:36.127Z",
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
          "nativeSession": "01a1113e-65dd-7822-9033-cde625ea52e3",
          "callPart": 10,
          "resultPart": 11,
          "callTimestamp": "2026-10-06T12:45:52.332Z",
          "responseTimestamp": "2026-10-06T12:46:11.285Z",
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
          "nativeSession": "01a1113e-65dd-7822-9033-cde625ea52e3",
          "callPart": 12,
          "resultPart": 13,
          "callTimestamp": "2026-10-06T12:46:16.013Z",
          "responseTimestamp": "2026-10-06T12:46:16.351Z",
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
          "nativeSession": "01a1113e-65dd-7822-9033-cde625ea52e3",
          "callPart": 15,
          "resultPart": 16,
          "callTimestamp": "2026-10-06T12:46:47.419Z",
          "responseTimestamp": "2026-10-06T12:46:54.166Z",
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
          "nativeSession": "01a1113e-65dd-7822-9033-cde625ea52e3",
          "callPart": 17,
          "resultPart": 18,
          "callTimestamp": "2026-10-06T12:47:21.661Z",
          "responseTimestamp": "2026-10-06T12:47:21.796Z",
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
          "nativeSession": "01a1113e-65dd-7822-9033-cde625ea52e3",
          "callPart": 19,
          "resultPart": 20,
          "callTimestamp": "2026-10-06T12:48:11.767Z",
          "responseTimestamp": "2026-10-06T12:48:42.897Z",
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
          "nativeSession": "01a1113e-65dd-7822-9033-cde625ea52e3",
          "callPart": 19,
          "resultPart": 22,
          "callTimestamp": "2026-10-06T12:48:11.767Z",
          "responseTimestamp": "2026-10-06T12:49:00.344Z",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "8",
            "links": [
              {
                "yieldPart": 20,
                "waitPart": 21,
                "precedingCallPart": 19
              }
            ],
            "waitPart": 21,
            "originalCallPart": 19
          },
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
          "nativeSession": "01a1113e-65dd-7822-9033-cde625ea52e3",
          "callPart": 23,
          "resultPart": 24,
          "callTimestamp": "2026-10-06T12:50:02.871Z",
          "responseTimestamp": "2026-10-06T12:50:14.114Z",
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
          "nativeSession": "01a1113e-65dd-7822-9033-cde625ea52e3",
          "callPart": 25,
          "resultPart": 26,
          "callTimestamp": "2026-10-06T12:51:12.790Z",
          "responseTimestamp": "2026-10-06T12:51:23.323Z",
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
          "nativeSession": "01a1113e-65dd-7822-9033-cde625ea52e3",
          "callPart": 28,
          "resultPart": 29,
          "callTimestamp": "2026-10-06T12:51:47.844Z",
          "responseTimestamp": "2026-10-06T12:51:52.679Z",
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
          "nativeSession": "01a1113e-65dd-7822-9033-cde625ea52e3",
          "callPart": 30,
          "resultPart": 31,
          "callTimestamp": "2026-10-06T12:52:18.344Z",
          "responseTimestamp": "2026-10-06T12:52:21.239Z",
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
          "nativeSession": "01a1113e-65dd-7822-9033-cde625ea52e3",
          "callPart": 32,
          "resultPart": 33,
          "callTimestamp": "2026-10-06T12:52:51.802Z",
          "responseTimestamp": "2026-10-06T12:52:57.452Z",
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
          "nativeSession": "01a1113e-65dd-7822-9033-cde625ea52e3",
          "callPart": 34,
          "resultPart": 35,
          "callTimestamp": "2026-10-06T12:53:19.225Z",
          "responseTimestamp": "2026-10-06T12:53:27.407Z",
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
          "nativeSession": "01a1113e-65dd-7822-9033-cde625ea52e3",
          "callPart": 36,
          "resultPart": 37,
          "callTimestamp": "2026-10-06T12:54:46.858Z",
          "responseTimestamp": "2026-10-06T12:54:50.089Z",
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
          "nativeSession": "01a1113e-65dd-7822-9033-cde625ea52e3",
          "callPart": 38,
          "resultPart": 39,
          "callTimestamp": "2026-10-06T12:55:00.175Z",
          "responseTimestamp": "2026-10-06T12:55:00.241Z",
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
          "nativeSession": "01a1113e-65dd-7822-9033-cde625ea52e3",
          "callPart": 40,
          "resultPart": 41,
          "callTimestamp": "2026-10-06T12:55:33.541Z",
          "responseTimestamp": "2026-10-06T12:55:39.638Z",
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
          "nativeSession": "01a1113e-65dd-7822-9033-cde625ea52e3",
          "callPart": 42,
          "resultPart": 43,
          "callTimestamp": "2026-10-06T12:58:01.421Z",
          "responseTimestamp": "2026-10-06T12:58:10.562Z",
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
          "nativeSession": "01a1113e-65dd-7822-9033-cde625ea52e3",
          "callPart": 44,
          "resultPart": 45,
          "callTimestamp": "2026-10-06T12:58:47.132Z",
          "responseTimestamp": "2026-10-06T12:58:47.430Z",
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
          "nativeSession": "01a1113e-65dd-7822-9033-cde625ea52e3",
          "callPart": 46,
          "resultPart": 47,
          "callTimestamp": "2026-10-06T12:59:17.621Z",
          "responseTimestamp": "2026-10-06T12:59:24.096Z",
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
          "nativeSession": "01a1113e-65dd-7822-9033-cde625ea52e3",
          "callPart": 48,
          "resultPart": 49,
          "callTimestamp": "2026-10-06T12:59:54.014Z",
          "responseTimestamp": "2026-10-06T12:59:59.953Z",
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
          "nativeSession": "01a1113e-65dd-7822-9033-cde625ea52e3",
          "callPart": 50,
          "resultPart": 51,
          "callTimestamp": "2026-10-06T13:00:29.054Z",
          "responseTimestamp": "2026-10-06T13:00:43.870Z",
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
          "nativeSession": "01a1113e-65dd-7822-9033-cde625ea52e3",
          "callPart": 52,
          "resultPart": 53,
          "callTimestamp": "2026-10-06T13:01:13.338Z",
          "responseTimestamp": "2026-10-06T13:01:18.019Z",
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
          "nativeSession": "01a1113e-65dd-7822-9033-cde625ea52e3",
          "callPart": 54,
          "resultPart": 55,
          "callTimestamp": "2026-10-06T13:01:47.057Z",
          "responseTimestamp": "2026-10-06T13:01:52.233Z",
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
          "nativeSession": "01a1113e-65dd-7822-9033-cde625ea52e3",
          "callPart": 56,
          "resultPart": 57,
          "callTimestamp": "2026-10-06T13:02:26.620Z",
          "responseTimestamp": "2026-10-06T13:02:31.766Z",
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
          "nativeSession": "01a1113e-65dd-7822-9033-cde625ea52e3",
          "callPart": 59,
          "resultPart": 60,
          "callTimestamp": "2026-10-06T13:07:22.570Z",
          "responseTimestamp": "2026-10-06T13:07:22.687Z",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": false,
          "sourceComplete": true,
          "parseErrors": 44,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        },
        {
          "nativeSession": "01a1113e-65dd-7822-9033-cde625ea52e3",
          "callPart": 61,
          "resultPart": 62,
          "callTimestamp": "2026-10-06T13:08:14.935Z",
          "responseTimestamp": "2026-10-06T13:08:46.006Z",
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
          "nativeSession": "01a1113e-65dd-7822-9033-cde625ea52e3",
          "callPart": 61,
          "resultPart": 64,
          "callTimestamp": "2026-10-06T13:08:14.935Z",
          "responseTimestamp": "2026-10-06T13:08:49.154Z",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "27",
            "links": [
              {
                "yieldPart": 62,
                "waitPart": 63,
                "precedingCallPart": 61
              }
            ],
            "waitPart": 63,
            "originalCallPart": 61
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
          "nativeSession": "01a1113e-65dd-7822-9033-cde625ea52e3",
          "callPart": 65,
          "resultPart": 66,
          "callTimestamp": "2026-10-06T13:09:36.086Z",
          "responseTimestamp": "2026-10-06T13:09:56.107Z",
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
          "nativeSession": "01a1113e-65dd-7822-9033-cde625ea52e3",
          "callPart": 67,
          "resultPart": 68,
          "callTimestamp": "2026-10-06T13:10:19.667Z",
          "responseTimestamp": "2026-10-06T13:10:40.277Z",
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
          "nativeSession": "01a1113e-65dd-7822-9033-cde625ea52e3",
          "callPart": 70,
          "resultPart": 71,
          "callTimestamp": "2026-10-06T13:11:35.718Z",
          "responseTimestamp": "2026-10-06T13:12:07.355Z",
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
          "nativeSession": "01a1113e-65dd-7822-9033-cde625ea52e3",
          "callPart": 70,
          "resultPart": 74,
          "callTimestamp": "2026-10-06T13:11:35.718Z",
          "responseTimestamp": "2026-10-06T13:12:35.635Z",
          "mechanisms": [
            "native-wrapper"
          ],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "30",
            "links": [
              {
                "yieldPart": 71,
                "waitPart": 73,
                "precedingCallPart": 70
              }
            ],
            "waitPart": 73,
            "originalCallPart": 70
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
      "outcomeJoined": false,
      "acceptedUnique": true,
      "acceptedPairCount": 1,
      "assessmentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold30-recovered-native01a1113e-original32231391-assessment-424d5.json",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold28-backup-original-native-01a1113e-65dd-7822-9033-cde625ea52e3-424d5.jsonl",
      "instrumentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold26-native-analysis-instrument-424d5.json"
    },
    {
      "owner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
      "request_id": "32243511",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a11158-b6c7-7c23-8712-bc632b5004fa",
          "callPart": 115,
          "resultPart": 116,
          "literalArgsEqual": true,
          "ledgerOwner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-06 13:34:59.639+00",
          "durationMs": 2422,
          "derivedDispatchStart": "2026-10-06T13:34:57.217Z",
          "callTimestamp": "2026-10-06T13:34:56.224+00:00",
          "responseTimestamp": "2026-10-06T13:34:59.831+00:00",
          "callBeforeDispatchMs": 993,
          "responseAfterSettleMs": 192,
          "bounds": true,
          "noAmbiguity": true,
          "error": "no-leading-json-format-or-complete-json-stream",
          "state": "unclassified",
          "statusAgrees": false,
          "accepted": false,
          "sourceComplete": false
        }
      ],
      "rejected": [],
      "receiptState": "unresolved",
      "acceptedUnique": false,
      "reason": "no-accepted-complete-pair",
      "cold24Reassessment": {
        "owner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
        "request_id": "32243511",
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
      "cold25Assessment": {
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
      "cold26Assessment": {
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
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch1-424d5.json",
        "outcomeJoined": false
      },
      "cold27Assessment": {
        "request_id": "32243511",
        "owner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "acceptedPairCount": 0,
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
        "outcomeJoined": false,
        "assessmentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold27-original45-lineage-augmentation-batch1-424d5.json",
        "sourceLocationAssessment": {
          "request_id": "32243511",
          "owner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
          "ledger": {
            "id": "32243511",
            "tool_name": "session:request-compaction",
            "coord_owner_id": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
            "invoked_at": "2026-10-06 13:34:59.639+00",
            "duration_ms": 2422,
            "status": "ok",
            "args_json": {
              "focus": "Settle EI-25223755767814811 completionAuthority=proposed. Inspect the full work_items:complete authorityWarning (content identity unproven for 3 filesChanged paths), current completion contract, and actual changed-file identity evidence. Preserve the verified 35/35 test result and root-cause fact. Do not treat the item as counted toward burn-down until authority is settled; then resume the active fleet lane via scheduler:get_next.",
              "autoContinue": true
            }
          },
          "sourceRefs": [
            "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch1-424d5.json"
          ],
          "nativeSessions": [
            "01a11158-b6c7-7c23-8712-bc632b5004fa"
          ],
          "originalCandidateCount": 1,
          "lineageCount": 3,
          "unofferedToolUses": [],
          "scopedLocationsMissing": true,
          "outcomeJoined": false
        }
      }
    },
    {
      "owner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
      "request_id": "32259530",
      "acceptedUnique": true,
      "completeOriginalPair": true,
      "receiptState": "queued",
      "pairs": [
        {
          "nativeSession": "01a1116d-047a-71f2-a719-b43eb100ae49",
          "callPart": 86,
          "resultPart": 87,
          "callTimestamp": "2026-10-06T14:02:33.078+00:00",
          "responseTimestamp": "2026-10-06T14:02:42.046+00:00",
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
          "nativeSession": "01a1116d-047a-71f2-a719-b43eb100ae49",
          "callPart": 88,
          "resultPart": 89,
          "callTimestamp": "2026-10-06T14:02:59.857+00:00",
          "responseTimestamp": "2026-10-06T14:03:30.244+00:00",
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
      "outcomeJoined": false,
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-native-assessment-batch1-424d5.json"
    },
    {
      "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
      "request_id": "34800973",
      "acceptedUnique": true,
      "completeOriginalPair": true,
      "receiptState": "queued",
      "pairs": [
        {
          "nativeSession": "01a121a0-ce00-7b80-878e-b7de5741bed6",
          "callPart": 177,
          "resultPart": 178,
          "callTimestamp": "2026-10-09T17:34:48.362+00:00",
          "responseTimestamp": "2026-10-09T17:35:09.495+00:00",
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
      "outcomeJoined": false,
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-native-assessment-batch1-424d5.json"
    },
    {
      "owner": "su-ab8cc07f-e903-4467-ac45-a32149258170",
      "request_id": "34805876",
      "acceptedUnique": true,
      "completeOriginalPair": true,
      "receiptState": "queued",
      "pairs": [
        {
          "nativeSession": "01a121ba-c573-7653-bef3-77028f51c4b1",
          "callPart": 76,
          "resultPart": 77,
          "callTimestamp": "2026-10-09T17:46:12.885+00:00",
          "responseTimestamp": "2026-10-09T17:46:15.91+00:00",
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
          "nativeSession": "01a121ba-c573-7653-bef3-77028f51c4b1",
          "callPart": 79,
          "resultPart": 80,
          "callTimestamp": "2026-10-09T17:46:26.055+00:00",
          "responseTimestamp": "2026-10-09T17:46:48.095+00:00",
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
      "outcomeJoined": false,
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-native-assessment-batch1-424d5.json"
    },
    {
      "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
      "request_id": "34826842",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 0,
      "pairs": [
        {
          "nativeSession": "01a121d9-d398-73d1-9c88-63eb0cf9aec2",
          "callPart": 120,
          "resultPart": 121,
          "callTimestamp": "2026-10-09T18:27:50.067+00:00",
          "responseTimestamp": "2026-10-09T18:27:52.493+00:00",
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
          "receiptState": "queued",
          "statusAgrees": true,
          "format": "toon",
          "requested": true,
          "respawn": "queued",
          "completeOriginalPair": true,
          "accepted": true,
          "state": "queued"
        }
      ],
      "rejected": [
        {
          "session": "01a121d9-d398-73d1-9c88-63eb0cf9aec2",
          "part": 120,
          "reason": "Error: nonliteral argument:Identifier"
        }
      ],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null,
      "priorAssessment": {
        "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
        "request_id": "34826842",
        "ledgerStatus": "ok",
        "candidates": 1,
        "exactArgumentMatches": 0,
        "pairs": [],
        "rejected": [
          {
            "session": "01a121d9-d398-73d1-9c88-63eb0cf9aec2",
            "part": 120,
            "reason": "Error: nonliteral argument:Identifier"
          }
        ],
        "receiptState": "unresolved",
        "acceptedUnique": false,
        "reason": "no-accepted-complete-pair"
      },
      "custodySource": "audits/parked-agent-resumption-2026-10-09/r13-cold23-five-original-custody-424d5.json",
      "currentSourceAssessment": {
        "request_id": "34826842",
        "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
        "completeOriginalPair": true,
        "pairs": [
          {
            "nativeSession": "01a121d9-d398-73d1-9c88-63eb0cf9aec2",
            "callPart": 120,
            "resultPart": 121,
            "callTimestamp": "2026-10-09T18:27:50.067+00:00",
            "responseTimestamp": "2026-10-09T18:27:52.493+00:00",
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
      }
    },
    {
      "owner": "su-ab8cc07f-e903-4467-ac45-a32149258170",
      "request_id": "34831365",
      "ledgerStatus": "ok",
      "candidates": 0,
      "exactArgumentMatches": 0,
      "pairs": [],
      "rejected": [],
      "receiptState": "unresolved",
      "acceptedUnique": false,
      "reason": "no-accepted-complete-pair",
      "cold24Reassessment": {
        "owner": "su-ab8cc07f-e903-4467-ac45-a32149258170",
        "request_id": "34831365",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [],
        "acceptedPairCount": 0,
        "outcomeJoined": false
      },
      "cold25Assessment": {
        "request_id": "34831365",
        "owner": "su-ab8cc07f-e903-4467-ac45-a32149258170",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [],
        "acceptedPairCount": 0,
        "outcomeJoined": false
      },
      "cold26Assessment": {
        "request_id": "34831365",
        "owner": "su-ab8cc07f-e903-4467-ac45-a32149258170",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [],
        "acceptedPairCount": 0,
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch1-424d5.json",
        "outcomeJoined": false
      },
      "cold27Assessment": {
        "request_id": "34831365",
        "owner": "su-ab8cc07f-e903-4467-ac45-a32149258170",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "acceptedPairCount": 0,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a121dd-4682-7970-a877-d48365ae96af",
            "callPart": 130,
            "resultPart": 131,
            "callTimestamp": "2026-10-09T18:34:45.009+00:00",
            "responseTimestamp": "2026-10-09T18:34:48.818+00:00",
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
            "nativeSession": "01a121dd-4682-7970-a877-d48365ae96af",
            "callPart": 132,
            "resultPart": 133,
            "callTimestamp": "2026-10-09T18:35:15.556+00:00",
            "responseTimestamp": "2026-10-09T18:35:28.455+00:00",
            "mechanisms": [],
            "conditionalAlternatives": false,
            "chain": null,
            "literalArgsEqual": false,
            "ownerEqual": true,
            "bounds": true,
            "sourceComplete": false,
            "parseErrors": 3,
            "receiptState": "unclassified",
            "statusAgrees": false,
            "completeOriginalPair": false
          },
          {
            "nativeSession": "01a121f3-2211-7912-b4f6-78fd26b41ca4",
            "callPart": 4,
            "resultPart": 5,
            "callTimestamp": "2026-10-09T18:36:05.404+00:00",
            "responseTimestamp": "2026-10-09T18:36:05.484+00:00",
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
            "nativeSession": "01a121f3-2211-7912-b4f6-78fd26b41ca4",
            "callPart": 6,
            "resultPart": 7,
            "callTimestamp": "2026-10-09T18:36:10.828+00:00",
            "responseTimestamp": "2026-10-09T18:36:41.864+00:00",
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
        "outcomeJoined": false,
        "assessmentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold27-original45-lineage-augmentation-batch1-424d5.json",
        "sourceLocationAssessment": {
          "request_id": "34831365",
          "owner": "su-ab8cc07f-e903-4467-ac45-a32149258170",
          "ledger": {
            "id": "34831365",
            "tool_name": "session:request-compaction",
            "coord_owner_id": "su-ab8cc07f-e903-4467-ac45-a32149258170",
            "invoked_at": "2026-10-09 18:35:28.141+00",
            "duration_ms": 2398,
            "status": "ok",
            "args_json": {
              "focus": "Continue fleet claim-spec mission. Verify and repair existing cold loop delivery-to-turn path; do not arm a duplicate. Current live loop remains active but rewake is not guaranteed after a suppressed-redundant wake. EI-25521785505149415 is dropped as false positive with recovered exact script evidence. scheduler:get_next is floor-gated with 589 pending agent-review items; process one spec-admitted review item after loop recovery.",
              "autoContinue": true
            }
          },
          "sourceRefs": [
            "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch1-424d5.json"
          ],
          "nativeSessions": [
            "01a121dd-4682-7970-a877-d48365ae96af",
            "01a121f3-2211-7912-b4f6-78fd26b41ca4"
          ],
          "originalCandidateCount": 4,
          "lineageCount": 10,
          "unofferedToolUses": [
            {
              "session_id": "01a121f3-2211-7912-b4f6-78fd26b41ca4",
              "part_idx": 8,
              "tool_name": "wait",
              "chars": 55,
              "clipped": false
            }
          ],
          "scopedLocationsMissing": true,
          "outcomeJoined": false
        }
      }
    },
    {
      "owner": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
      "request_id": "34836688",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a121eb-3503-7542-b2aa-9e568eec1d49",
          "callPart": 128,
          "resultPart": 129,
          "literalArgsEqual": true,
          "ledgerOwner": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-09 18:45:26.137+00",
          "durationMs": 13653,
          "derivedDispatchStart": "2026-10-09T18:45:12.484Z",
          "callTimestamp": "2026-10-09 14:45:11.787-04",
          "responseTimestamp": "2026-10-09 14:45:29.143-04",
          "callBeforeDispatchMs": 697,
          "responseAfterSettleMs": 3006,
          "bounds": true,
          "noAmbiguity": true,
          "format": "toon",
          "textBlocks": 2,
          "body": {
            "ok": true,
            "requested": true,
            "respawn": "queued",
            "budgetChars": 331360,
            "firstPromptSource": "continuation-note",
            "staleCheckpoints": [],
            "openOwnerQuestion": false,
            "priorRespawn": {
              "outcome": "delivered",
              "ts": "2026-10-09T18:27:18.786Z",
              "ageMs": 1086326,
              "capMs": null
            },
            "note": "Carry-respawn QUEUED — not performed yet. The host cuts this process only once your pty goes QUIET at a clean boundary, then respawns your successor on the deterministic carry document. It re-polls for a few minutes and can terminally DROP the carry — an interactive back-and-forth, or steady output, can supersede it indefinitely. So: wrap up and go quiet now, but FLUSH durable state first (work_items:checkpoint / loop:checkpoint / facts:assert) rather than relying on the cut. If you are still here on your next turn, it did not happen — re-request at the next clean stopping point instead of waiting."
          },
          "state": "queued",
          "statusAgrees": true,
          "accepted": true,
          "sourceComplete": true
        }
      ],
      "rejected": [],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null
    },
    {
      "owner": "su-ab8cc07f-e903-4467-ac45-a32149258170",
      "request_id": "34840615",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 0,
      "pairs": [],
      "rejected": [],
      "receiptState": "unresolved",
      "acceptedUnique": false,
      "reason": "no-accepted-complete-pair",
      "cold24Reassessment": {
        "owner": "su-ab8cc07f-e903-4467-ac45-a32149258170",
        "request_id": "34840615",
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
      "cold25Assessment": {
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
      "cold26Assessment": {
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
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch1-424d5.json",
        "outcomeJoined": false
      },
      "cold27Assessment": {
        "request_id": "34840615",
        "owner": "su-ab8cc07f-e903-4467-ac45-a32149258170",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "acceptedPairCount": 0,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a121f3-2211-7912-b4f6-78fd26b41ca4",
            "callPart": 118,
            "resultPart": 119,
            "callTimestamp": "2026-10-09T18:50:41.596+00:00",
            "responseTimestamp": "2026-10-09T18:50:42.862+00:00",
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
          },
          {
            "nativeSession": "01a121f3-2211-7912-b4f6-78fd26b41ca4",
            "callPart": 125,
            "resultPart": 126,
            "callTimestamp": "2026-10-09T18:52:11.891+00:00",
            "responseTimestamp": "2026-10-09T18:52:11.968+00:00",
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
            "callPart": 127,
            "resultPart": 128,
            "callTimestamp": "2026-10-09T18:52:17.684+00:00",
            "responseTimestamp": "2026-10-09T18:52:23.948+00:00",
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
            "nativeSession": "01a121f3-2211-7912-b4f6-78fd26b41ca4",
            "callPart": 129,
            "resultPart": 130,
            "callTimestamp": "2026-10-09T18:52:27.771+00:00",
            "responseTimestamp": "2026-10-09T18:52:30.87+00:00",
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
          }
        ],
        "outcomeJoined": false,
        "assessmentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold27-original45-lineage-augmentation-batch1-424d5.json",
        "sourceLocationAssessment": {
          "request_id": "34840615",
          "owner": "su-ab8cc07f-e903-4467-ac45-a32149258170",
          "ledger": {
            "id": "34840615",
            "tool_name": "session:request-compaction",
            "coord_owner_id": "su-ab8cc07f-e903-4467-ac45-a32149258170",
            "invoked_at": "2026-10-09 18:51:39.411+00",
            "duration_ms": 1034,
            "status": "ok",
            "args_json": {
              "focus": "Fleet member in nonp2p-bug-drain-luna-max-0930. Verify identity before acting. Recovery marker/control hash is complete; declare lane, do not re-orient unless the hash changed. No work-item held. Unknown improvements:agent-review claim-next outcome under idempotency key 48712658-7a38-40e8-9f18-cb163b8d1ead; assignment reads were empty. Reconcile before any new claim. Do not use sample EI-23699892958295094 without refreshing; claimable review samples are read-only. Leader message was delivered, but wake was missed while the leader was live; pickup unconfirmed. Next: verify a loop-origin turn, refresh a spec-scoped review sample, then use targeted review claim after reconciling the unknown mutation.",
              "autoContinue": true
            }
          },
          "sourceRefs": [
            "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch1-424d5.json"
          ],
          "nativeSessions": [
            "01a121f3-2211-7912-b4f6-78fd26b41ca4"
          ],
          "originalCandidateCount": 6,
          "lineageCount": 14,
          "unofferedToolUses": [
            {
              "session_id": "01a121f3-2211-7912-b4f6-78fd26b41ca4",
              "part_idx": 131,
              "tool_name": "exec",
              "chars": 157,
              "clipped": false
            }
          ],
          "scopedLocationsMissing": true,
          "outcomeJoined": false
        }
      }
    },
    {
      "owner": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
      "request_id": "34855337",
      "ledgerStatus": "ok",
      "candidates": 2,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a121fc-57f2-7932-b336-bb7206c0e5a8",
          "callPart": 211,
          "resultPart": 214,
          "callTimestamp": "2026-10-09 19:17:54.341+00",
          "responseTimestamp": "2026-10-09 15:18:35.106-04",
          "mechanisms": [
            "invoke"
          ],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "96",
            "yieldPart": 212,
            "waitPart": 213,
            "originalCallPart": 211
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
          "completeOriginalPair": true,
          "accepted": true,
          "state": "queued"
        }
      ],
      "rejected": [],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null,
      "priorAssessment": {
        "owner": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
        "request_id": "34855337",
        "ledgerStatus": "ok",
        "candidates": 2,
        "exactArgumentMatches": 1,
        "pairs": [
          {
            "nativeSession": "01a121fc-57f2-7932-b336-bb7206c0e5a8",
            "callPart": 211,
            "resultPart": 212,
            "literalArgsEqual": true,
            "ledgerOwner": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
            "ownerEqual": true,
            "ledgerSettle": "2026-10-09 19:18:30.408+00",
            "durationMs": 35143,
            "derivedDispatchStart": "2026-10-09T19:17:55.265Z",
            "callTimestamp": "2026-10-09 15:17:54.341-04",
            "responseTimestamp": "2026-10-09 15:18:25.714-04",
            "callBeforeDispatchMs": 924,
            "responseAfterSettleMs": -4694,
            "bounds": false,
            "noAmbiguity": true,
            "error": "no-leading-json-format-or-complete-json-stream",
            "state": "unclassified",
            "statusAgrees": false,
            "accepted": false,
            "sourceComplete": true
          }
        ],
        "rejected": [],
        "receiptState": "unresolved",
        "acceptedUnique": false,
        "reason": "no-accepted-complete-pair"
      },
      "custodySource": "audits/parked-agent-resumption-2026-10-09/r13-cold23-remaining-wait-assessment-424d5.json",
      "currentSourceAssessment": {
        "request_id": "34855337",
        "owner": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
        "completeOriginalPair": true,
        "pairs": [
          {
            "nativeSession": "01a121fc-57f2-7932-b336-bb7206c0e5a8",
            "callPart": 211,
            "resultPart": 214,
            "callTimestamp": "2026-10-09 19:17:54.341+00",
            "responseTimestamp": "2026-10-09 15:18:35.106-04",
            "mechanisms": [
              "invoke"
            ],
            "conditionalAlternatives": false,
            "chain": {
              "cellId": "96",
              "yieldPart": 212,
              "waitPart": 213,
              "originalCallPart": 211
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
      }
    },
    {
      "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
      "request_id": "34863926",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a12212-c9fe-7921-bc00-6644cf505bab",
          "callPart": 121,
          "resultPart": 122,
          "literalArgsEqual": true,
          "ledgerOwner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-09 19:33:44.436+00",
          "durationMs": 739,
          "derivedDispatchStart": "2026-10-09T19:33:43.697Z",
          "callTimestamp": "2026-10-09T19:33:42.959+00:00",
          "responseTimestamp": "2026-10-09T19:33:44.975+00:00",
          "callBeforeDispatchMs": 738,
          "responseAfterSettleMs": 539,
          "bounds": true,
          "noAmbiguity": true,
          "error": "no-compaction-body",
          "state": "unclassified",
          "statusAgrees": false,
          "accepted": false,
          "sourceComplete": false
        }
      ],
      "rejected": [],
      "receiptState": "unresolved",
      "acceptedUnique": false,
      "reason": "no-accepted-complete-pair",
      "cold24Reassessment": {
        "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
        "request_id": "34863926",
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
      "cold25Assessment": {
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
      "cold26Assessment": {
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
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch1-424d5.json",
        "outcomeJoined": false
      },
      "cold27Assessment": {
        "request_id": "34863926",
        "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "acceptedPairCount": 0,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a12212-c9fe-7921-bc00-6644cf505bab",
            "callPart": 113,
            "resultPart": 114,
            "callTimestamp": "2026-10-09T19:32:50.594+00:00",
            "responseTimestamp": "2026-10-09T19:32:51.184+00:00",
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
            "nativeSession": "01a12212-c9fe-7921-bc00-6644cf505bab",
            "callPart": 115,
            "resultPart": 116,
            "callTimestamp": "2026-10-09T19:33:00.666+00:00",
            "responseTimestamp": "2026-10-09T19:33:02.643+00:00",
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
            "nativeSession": "01a12212-c9fe-7921-bc00-6644cf505bab",
            "callPart": 117,
            "resultPart": 118,
            "callTimestamp": "2026-10-09T19:33:07.72+00:00",
            "responseTimestamp": "2026-10-09T19:33:08.341+00:00",
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
            "nativeSession": "01a12212-c9fe-7921-bc00-6644cf505bab",
            "callPart": 119,
            "resultPart": 120,
            "callTimestamp": "2026-10-09T19:33:25.398+00:00",
            "responseTimestamp": "2026-10-09T19:33:27.283+00:00",
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
          },
          {
            "nativeSession": "01a12228-9932-7040-a68b-192083ea9f40",
            "callPart": 4,
            "resultPart": 5,
            "callTimestamp": "2026-10-09T19:34:16.85+00:00",
            "responseTimestamp": "2026-10-09T19:34:17.012+00:00",
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
            "nativeSession": "01a12228-9932-7040-a68b-192083ea9f40",
            "callPart": 6,
            "resultPart": 7,
            "callTimestamp": "2026-10-09T19:34:21.642+00:00",
            "responseTimestamp": "2026-10-09T19:34:21.698+00:00",
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
            "nativeSession": "01a12228-9932-7040-a68b-192083ea9f40",
            "callPart": 8,
            "resultPart": 9,
            "callTimestamp": "2026-10-09T19:34:28.248+00:00",
            "responseTimestamp": "2026-10-09T19:34:28.294+00:00",
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
            "nativeSession": "01a12228-9932-7040-a68b-192083ea9f40",
            "callPart": 10,
            "resultPart": 11,
            "callTimestamp": "2026-10-09T19:34:34.473+00:00",
            "responseTimestamp": "2026-10-09T19:34:47.206+00:00",
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
          }
        ],
        "outcomeJoined": false,
        "assessmentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold27-original45-lineage-augmentation-batch1-424d5.json",
        "sourceLocationAssessment": {
          "request_id": "34863926",
          "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
          "ledger": {
            "id": "34863926",
            "tool_name": "session:request-compaction",
            "coord_owner_id": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
            "invoked_at": "2026-10-09 19:33:44.436+00",
            "duration_ms": 739,
            "status": "ok",
            "args_json": {
              "focus": "Continue EI-25518476930001342. Stable request-trace matching is wired into initial and late result-door backfills; the focused test passed 19/19 with stable source evidence. The file lock is released and both item/loop carry notes are refreshed. Historical invocation 34756737 still has no spill settlement status, so its scratch result and the reason for its 41.6s write remain unknown. Next: inspect exact port-3271 evidence, run focused typecheck, then close only with rootCauseVerification and the unknown recorded.",
              "autoContinue": true
            }
          },
          "sourceRefs": [
            "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch1-424d5.json"
          ],
          "nativeSessions": [
            "01a12212-c9fe-7921-bc00-6644cf505bab",
            "01a12228-9932-7040-a68b-192083ea9f40"
          ],
          "originalCandidateCount": 9,
          "lineageCount": 20,
          "unofferedToolUses": [],
          "scopedLocationsMissing": true,
          "outcomeJoined": false
        }
      }
    },
    {
      "owner": "su-ab8cc07f-e903-4467-ac45-a32149258170",
      "request_id": "34866872",
      "ledgerStatus": "ok",
      "candidates": 0,
      "exactArgumentMatches": 0,
      "pairs": [],
      "rejected": [],
      "receiptState": "unresolved",
      "acceptedUnique": false,
      "reason": "no-accepted-complete-pair",
      "cold24Reassessment": {
        "owner": "su-ab8cc07f-e903-4467-ac45-a32149258170",
        "request_id": "34866872",
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
      "cold25Assessment": {
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
      "cold26Assessment": {
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
              "links": [
                {
                  "yieldPart": 130,
                  "waitPart": 131,
                  "precedingCallPart": 129
                }
              ],
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
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch1-424d5.json",
        "outcomeJoined": false
      },
      "cold27Assessment": {
        "request_id": "34866872",
        "owner": "su-ab8cc07f-e903-4467-ac45-a32149258170",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "acceptedPairCount": 0,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a12215-f913-74d0-8930-463399a84938",
            "callPart": 127,
            "resultPart": 128,
            "callTimestamp": "2026-10-09T19:38:09.312+00:00",
            "responseTimestamp": "2026-10-09T19:38:20.277+00:00",
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
            "nativeSession": "01a12215-f913-74d0-8930-463399a84938",
            "callPart": 129,
            "resultPart": 130,
            "callTimestamp": "2026-10-09T19:38:29.111+00:00",
            "responseTimestamp": "2026-10-09T19:39:00.16+00:00",
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
          },
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
              "links": [
                {
                  "yieldPart": 130,
                  "waitPart": 131,
                  "precedingCallPart": 129
                }
              ],
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
        "outcomeJoined": false,
        "assessmentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold27-original45-lineage-augmentation-batch1-424d5.json",
        "sourceLocationAssessment": {
          "request_id": "34866872",
          "owner": "su-ab8cc07f-e903-4467-ac45-a32149258170",
          "ledger": {
            "id": "34866872",
            "tool_name": "session:request-compaction",
            "coord_owner_id": "su-ab8cc07f-e903-4467-ac45-a32149258170",
            "invoked_at": "2026-10-09 19:38:59.231+00",
            "duration_ms": 14552,
            "status": "ok",
            "args_json": {
              "focus": "Continue the cold fleet bug-drain loop from the verified checkpoint; next pull one admitted work item with scheduler:get_next.",
              "autoContinue": true
            }
          },
          "sourceRefs": [
            "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch1-424d5.json"
          ],
          "nativeSessions": [
            "01a12215-f913-74d0-8930-463399a84938"
          ],
          "originalCandidateCount": 3,
          "lineageCount": 7,
          "unofferedToolUses": [],
          "scopedLocationsMissing": true,
          "outcomeJoined": false
        }
      }
    },
    {
      "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
      "request_id": "34875390",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 2,
      "pairs": [
        {
          "nativeSession": "01a12228-9932-7040-a68b-192083ea9f40",
          "callPart": 108,
          "resultPart": 109,
          "callTimestamp": "2026-10-09T19:56:45.064+00:00",
          "responseTimestamp": "2026-10-09T19:56:46.369+00:00",
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
          "receiptState": "queued",
          "statusAgrees": true,
          "format": "toon",
          "requested": true,
          "respawn": "queued",
          "completeOriginalPair": true,
          "accepted": true,
          "state": "queued"
        }
      ],
      "rejected": [],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null,
      "priorAssessment": {
        "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
        "request_id": "34875390",
        "ledgerStatus": "ok",
        "candidates": 1,
        "exactArgumentMatches": 2,
        "pairs": [
          {
            "nativeSession": "01a12228-9932-7040-a68b-192083ea9f40",
            "callPart": 108,
            "resultPart": 109,
            "literalArgsEqual": true,
            "ledgerOwner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
            "ownerEqual": true,
            "ledgerSettle": "2026-10-09 19:56:45.945+00",
            "durationMs": 646,
            "derivedDispatchStart": "2026-10-09T19:56:45.299Z",
            "callTimestamp": "2026-10-09T19:56:45.064+00:00",
            "responseTimestamp": "2026-10-09T19:56:46.369+00:00",
            "callBeforeDispatchMs": 235,
            "responseAfterSettleMs": 424,
            "bounds": true,
            "noAmbiguity": false,
            "format": "toon",
            "textBlocks": 2,
            "body": {
              "ok": true,
              "requested": true,
              "respawn": "queued",
              "budgetChars": 331360,
              "firstPromptSource": "continuation-note",
              "staleCheckpoints": [],
              "openOwnerQuestion": false,
              "priorRespawn": {
                "outcome": "delivered",
                "ts": "2026-10-09T19:34:14.584Z",
                "ageMs": 1351333,
                "capMs": null
              },
              "note": "Carry-respawn QUEUED — not performed yet. The host cuts this process only once your pty goes QUIET at a clean boundary, then respawns your successor on the deterministic carry document. It re-polls for a few minutes and can terminally DROP the carry — an interactive back-and-forth, or steady output, can supersede it indefinitely. So: wrap up and go quiet now, but FLUSH durable state first (work_items:checkpoint / loop:checkpoint / facts:assert) rather than relying on the cut. If you are still here on your next turn, it did not happen — re-request at the next clean stopping point instead of waiting."
            },
            "state": "queued",
            "statusAgrees": true,
            "accepted": false,
            "sourceComplete": true
          },
          {
            "nativeSession": "01a12228-9932-7040-a68b-192083ea9f40",
            "callPart": 108,
            "resultPart": 109,
            "literalArgsEqual": true,
            "ledgerOwner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
            "ownerEqual": true,
            "ledgerSettle": "2026-10-09 19:56:45.945+00",
            "durationMs": 646,
            "derivedDispatchStart": "2026-10-09T19:56:45.299Z",
            "callTimestamp": "2026-10-09T19:56:45.064+00:00",
            "responseTimestamp": "2026-10-09T19:56:46.369+00:00",
            "callBeforeDispatchMs": 235,
            "responseAfterSettleMs": 424,
            "bounds": true,
            "noAmbiguity": false,
            "format": "toon",
            "textBlocks": 2,
            "body": {
              "ok": true,
              "requested": true,
              "respawn": "queued",
              "budgetChars": 331360,
              "firstPromptSource": "continuation-note",
              "staleCheckpoints": [],
              "openOwnerQuestion": false,
              "priorRespawn": {
                "outcome": "delivered",
                "ts": "2026-10-09T19:34:14.584Z",
                "ageMs": 1351333,
                "capMs": null
              },
              "note": "Carry-respawn QUEUED — not performed yet. The host cuts this process only once your pty goes QUIET at a clean boundary, then respawns your successor on the deterministic carry document. It re-polls for a few minutes and can terminally DROP the carry — an interactive back-and-forth, or steady output, can supersede it indefinitely. So: wrap up and go quiet now, but FLUSH durable state first (work_items:checkpoint / loop:checkpoint / facts:assert) rather than relying on the cut. If you are still here on your next turn, it did not happen — re-request at the next clean stopping point instead of waiting."
            },
            "state": "queued",
            "statusAgrees": true,
            "accepted": false,
            "sourceComplete": true
          }
        ],
        "rejected": [],
        "receiptState": "unresolved",
        "acceptedUnique": false,
        "reason": "no-accepted-complete-pair"
      },
      "custodySource": "audits/parked-agent-resumption-2026-10-09/r13-cold23-remaining-direct-originals-424d5.json",
      "currentSourceAssessment": {
        "request_id": "34875390",
        "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
        "completeOriginalPair": true,
        "pairs": [
          {
            "nativeSession": "01a12228-9932-7040-a68b-192083ea9f40",
            "callPart": 108,
            "resultPart": 109,
            "callTimestamp": "2026-10-09T19:56:45.064+00:00",
            "responseTimestamp": "2026-10-09T19:56:46.369+00:00",
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
      }
    },
    {
      "owner": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
      "request_id": "34882439",
      "acceptedUnique": true,
      "completeOriginalPair": true,
      "receiptState": "queued",
      "pairs": [
        {
          "nativeSession": "01a1222c-d097-7e31-abe1-3d9adafedc1d",
          "callPart": 148,
          "resultPart": 149,
          "callTimestamp": "2026-10-09T20:10:47.778+00:00",
          "responseTimestamp": "2026-10-09T20:10:47.825+00:00",
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
          "nativeSession": "01a1222c-d097-7e31-abe1-3d9adafedc1d",
          "callPart": 150,
          "resultPart": 151,
          "callTimestamp": "2026-10-09T20:10:57.792+00:00",
          "responseTimestamp": "2026-10-09T20:11:13.627+00:00",
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
      "outcomeJoined": false,
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-native-assessment-batch1-424d5.json"
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
      "outcomeJoined": false,
      "assessmentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch1-424d5.json",
      "instrumentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold25-native-analysis-instrument-424d5.json"
    },
    {
      "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
      "request_id": "34887447",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 0,
      "pairs": [],
      "rejected": [],
      "receiptState": "unresolved",
      "acceptedUnique": false,
      "reason": "no-accepted-complete-pair",
      "cold24Reassessment": {
        "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
        "request_id": "34887447",
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
            "mechanisms": [],
            "conditionalAlternatives": false,
            "chain": null,
            "literalArgsEqual": false,
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
      "cold25Assessment": {
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
      "cold26Assessment": {
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
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch1-424d5.json",
        "outcomeJoined": false
      },
      "cold27Assessment": {
        "request_id": "34887447",
        "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "acceptedPairCount": 0,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a1223d-8d3b-73d2-ba27-19a009e9bfc7",
            "callPart": 121,
            "resultPart": 122,
            "callTimestamp": "2026-10-09T20:19:15.732+00:00",
            "responseTimestamp": "2026-10-09T20:19:19.443+00:00",
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
            "nativeSession": "01a1223d-8d3b-73d2-ba27-19a009e9bfc7",
            "callPart": 123,
            "resultPart": 124,
            "callTimestamp": "2026-10-09T20:19:41.494+00:00",
            "responseTimestamp": "2026-10-09T20:19:42.086+00:00",
            "mechanisms": [],
            "conditionalAlternatives": false,
            "chain": null,
            "literalArgsEqual": false,
            "ownerEqual": true,
            "bounds": false,
            "sourceComplete": false,
            "parseErrors": 5,
            "receiptState": "unclassified",
            "statusAgrees": false,
            "completeOriginalPair": false
          },
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
          },
          {
            "nativeSession": "01a12252-f80e-7341-b478-2a4df19537b8",
            "callPart": 4,
            "resultPart": 5,
            "callTimestamp": "2026-10-09T20:20:53.261+00:00",
            "responseTimestamp": "2026-10-09T20:20:53.455+00:00",
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
          }
        ],
        "outcomeJoined": false,
        "assessmentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold27-original45-lineage-augmentation-batch1-424d5.json",
        "sourceLocationAssessment": {
          "request_id": "34887447",
          "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
          "ledger": {
            "id": "34887447",
            "tool_name": "session:request-compaction",
            "coord_owner_id": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
            "invoked_at": "2026-10-09 20:19:56.241+00",
            "duration_ms": 763,
            "status": "ok",
            "args_json": {
              "focus": "Resume the AUTO fleet claim-spec lane. EI-25518476930001342 and EI-25527207529708796 are complete with rootCauseVerification; after context recovery, inspect the loop delivery-to-turn path because loop:status reports rewakeGuaranteed=false (last-fire-no-loop-turn), then pull only via scheduler:get_next in harness papercusp. Historical invocation 34756737 scratch outcome remains unknown.",
              "autoContinue": true
            }
          },
          "sourceRefs": [
            "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch1-424d5.json"
          ],
          "nativeSessions": [
            "01a1223d-8d3b-73d2-ba27-19a009e9bfc7",
            "01a12252-f80e-7341-b478-2a4df19537b8"
          ],
          "originalCandidateCount": 4,
          "lineageCount": 10,
          "unofferedToolUses": [
            {
              "session_id": "01a12252-f80e-7341-b478-2a4df19537b8",
              "part_idx": 6,
              "tool_name": "exec",
              "chars": 295,
              "clipped": false
            }
          ],
          "scopedLocationsMissing": true,
          "outcomeJoined": false
        }
      }
    },
    {
      "owner": "su-ab8cc07f-e903-4467-ac45-a32149258170",
      "request_id": "34888135",
      "ledgerStatus": "ok",
      "candidates": 0,
      "exactArgumentMatches": 0,
      "pairs": [],
      "rejected": [],
      "receiptState": "unresolved",
      "acceptedUnique": false,
      "reason": "no-accepted-complete-pair",
      "cold24Reassessment": {
        "owner": "su-ab8cc07f-e903-4467-ac45-a32149258170",
        "request_id": "34888135",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [],
        "acceptedPairCount": 0,
        "outcomeJoined": false
      },
      "cold25Assessment": {
        "request_id": "34888135",
        "owner": "su-ab8cc07f-e903-4467-ac45-a32149258170",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [],
        "acceptedPairCount": 0,
        "outcomeJoined": false
      },
      "cold26Assessment": {
        "request_id": "34888135",
        "owner": "su-ab8cc07f-e903-4467-ac45-a32149258170",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [],
        "acceptedPairCount": 0,
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch1-424d5.json",
        "outcomeJoined": false
      },
      "cold27Assessment": {
        "request_id": "34888135",
        "owner": "su-ab8cc07f-e903-4467-ac45-a32149258170",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "acceptedPairCount": 0,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a12236-1107-7490-8034-f4da1c37b581",
            "callPart": 167,
            "resultPart": 168,
            "callTimestamp": "2026-10-09T20:20:40.973+00:00",
            "responseTimestamp": "2026-10-09T20:20:59.955+00:00",
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
          },
          {
            "nativeSession": "01a12236-1107-7490-8034-f4da1c37b581",
            "callPart": 170,
            "resultPart": 171,
            "callTimestamp": "2026-10-09T20:21:25.383+00:00",
            "responseTimestamp": "2026-10-09T20:21:32.424+00:00",
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
            "nativeSession": "01a12254-3c2e-7f12-abef-2dfea70788c5",
            "callPart": 4,
            "resultPart": 5,
            "callTimestamp": "2026-10-09T20:21:57.108+00:00",
            "responseTimestamp": "2026-10-09T20:21:57.267+00:00",
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
          }
        ],
        "outcomeJoined": false,
        "assessmentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold27-original45-lineage-augmentation-batch1-424d5.json",
        "sourceLocationAssessment": {
          "request_id": "34888135",
          "owner": "su-ab8cc07f-e903-4467-ac45-a32149258170",
          "ledger": {
            "id": "34888135",
            "tool_name": "session:request-compaction",
            "coord_owner_id": "su-ab8cc07f-e903-4467-ac45-a32149258170",
            "invoked_at": "2026-10-09 20:20:57.978+00",
            "duration_ms": 3714,
            "status": "ok",
            "args_json": {
              "focus": "Resume EI-25526426284384525 from the work-item and loop checkpoints. Inspect the required source-map/test provenance evidence before any rerun; current capture.test.ts pass was 182/182 but provenance UNKNOWN because HEAD moved during the run. Continue from the exact next action in the checkpoints.",
              "autoContinue": true
            }
          },
          "sourceRefs": [
            "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch1-424d5.json"
          ],
          "nativeSessions": [
            "01a12236-1107-7490-8034-f4da1c37b581",
            "01a12254-3c2e-7f12-abef-2dfea70788c5"
          ],
          "originalCandidateCount": 3,
          "lineageCount": 9,
          "unofferedToolUses": [
            {
              "session_id": "01a12254-3c2e-7f12-abef-2dfea70788c5",
              "part_idx": 6,
              "tool_name": "exec",
              "chars": 638,
              "clipped": false
            }
          ],
          "scopedLocationsMissing": true,
          "outcomeJoined": false
        }
      }
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
      "outcomeJoined": false,
      "assessmentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch1-424d5.json",
      "instrumentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold25-native-analysis-instrument-424d5.json"
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
      "outcomeJoined": false,
      "assessmentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch1-424d5.json",
      "instrumentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold25-native-analysis-instrument-424d5.json"
    },
    {
      "owner": "su-ba80f2f7-46f6-4aec-b99a-21e02460933f",
      "request_id": "34912704",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 0,
      "pairs": [],
      "rejected": [],
      "receiptState": "unresolved",
      "acceptedUnique": false,
      "reason": "no-accepted-complete-pair",
      "cold24Reassessment": {
        "owner": "su-ba80f2f7-46f6-4aec-b99a-21e02460933f",
        "request_id": "34912704",
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
      "cold25Assessment": {
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
      "cold26Assessment": {
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
              "links": [
                {
                  "yieldPart": 139,
                  "waitPart": 140,
                  "precedingCallPart": 138
                }
              ],
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
            "callPart": 138,
            "resultPart": 143,
            "callTimestamp": "2026-10-09T21:02:07.475+00:00",
            "responseTimestamp": "2026-10-09T21:02:56.38+00:00",
            "mechanisms": [],
            "conditionalAlternatives": false,
            "chain": {
              "cellId": "55",
              "links": [
                {
                  "yieldPart": 139,
                  "waitPart": 140,
                  "precedingCallPart": 138
                },
                {
                  "yieldPart": 141,
                  "waitPart": 142,
                  "precedingCallPart": 140
                }
              ],
              "waitPart": 142,
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
          }
        ],
        "acceptedPairCount": 0,
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch1-424d5.json",
        "outcomeJoined": false
      },
      "cold27Assessment": {
        "request_id": "34912704",
        "owner": "su-ba80f2f7-46f6-4aec-b99a-21e02460933f",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "acceptedPairCount": 0,
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
            "callPart": 136,
            "resultPart": 137,
            "callTimestamp": "2026-10-09T21:01:46.433+00:00",
            "responseTimestamp": "2026-10-09T21:01:53.189+00:00",
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
              "links": [
                {
                  "yieldPart": 139,
                  "waitPart": 140,
                  "precedingCallPart": 138
                }
              ],
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
            "callPart": 138,
            "resultPart": 143,
            "callTimestamp": "2026-10-09T21:02:07.475+00:00",
            "responseTimestamp": "2026-10-09T21:02:56.38+00:00",
            "mechanisms": [],
            "conditionalAlternatives": false,
            "chain": {
              "cellId": "55",
              "links": [
                {
                  "yieldPart": 139,
                  "waitPart": 140,
                  "precedingCallPart": 138
                },
                {
                  "yieldPart": 141,
                  "waitPart": 142,
                  "precedingCallPart": 140
                }
              ],
              "waitPart": 142,
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
          }
        ],
        "outcomeJoined": false,
        "assessmentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold27-original45-lineage-augmentation-batch1-424d5.json",
        "sourceLocationAssessment": {
          "request_id": "34912704",
          "owner": "su-ba80f2f7-46f6-4aec-b99a-21e02460933f",
          "ledger": {
            "id": "34912704",
            "tool_name": "session:request-compaction",
            "coord_owner_id": "su-ba80f2f7-46f6-4aec-b99a-21e02460933f",
            "invoked_at": "2026-10-09 21:02:50.537+00",
            "duration_ms": 19882,
            "status": "ok",
            "args_json": {
              "focus": "Fleet member lane is still floor-gated; completed review EI-24371648636496583 (grade 2, returned to submitter). Checkpointed liveness observations. Latest loop status: active/cold, rewakeGuaranteed=false last-fire-no-loop-turn, executionRecovery=blocked/inference-observation-unavailable. Re-read loop status and checkpoint before the next scoped scheduler/review unit; do not re-arm or broaden scope without evidence.",
              "autoContinue": true,
              "continueNote": "Continue from the current checkpoint. Recovery marker/control hash are complete; do not re-orient while they match. First re-read loop:status and loop:checkpoint. If wake proof is still false, inspect the specific conditional recovery classifier and keep work scoped to the fleet claim-spec lane; do not re-arm blindly or fall through to the generic backlog."
            }
          },
          "sourceRefs": [
            "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch1-424d5.json"
          ],
          "nativeSessions": [
            "01a12266-3e63-7283-821f-8cbcd5c543fa"
          ],
          "originalCandidateCount": 5,
          "lineageCount": 11,
          "unofferedToolUses": [],
          "scopedLocationsMissing": true,
          "outcomeJoined": false
        }
      }
    },
    {
      "owner": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
      "request_id": "34924375",
      "acceptedUnique": true,
      "completeOriginalPair": true,
      "receiptState": "queued",
      "pairs": [
        {
          "nativeSession": "01a12278-2e15-7521-82f2-816b032ce988",
          "callPart": 114,
          "resultPart": 115,
          "callTimestamp": "2026-10-09T21:22:43.468+00:00",
          "responseTimestamp": "2026-10-09T21:23:01.019+00:00",
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
      "outcomeJoined": false,
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-native-assessment-batch1-424d5.json"
    },
    {
      "owner": "su-ba80f2f7-46f6-4aec-b99a-21e02460933f",
      "request_id": "34925297",
      "acceptedUnique": true,
      "completeOriginalPair": true,
      "receiptState": "queued",
      "pairs": [
        {
          "nativeSession": "01a1227a-27b3-79c3-990b-b101d7ea9a6c",
          "callPart": 112,
          "resultPart": 113,
          "callTimestamp": "2026-10-09T21:24:24.14+00:00",
          "responseTimestamp": "2026-10-09T21:24:24.182+00:00",
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
          "nativeSession": "01a1227a-27b3-79c3-990b-b101d7ea9a6c",
          "callPart": 114,
          "resultPart": 115,
          "callTimestamp": "2026-10-09T21:24:29.343+00:00",
          "responseTimestamp": "2026-10-09T21:24:46.238+00:00",
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
      "outcomeJoined": false,
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-native-assessment-batch1-424d5.json"
    },
    {
      "owner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
      "request_id": "34925804",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a12266-7409-79d3-9456-31ae1f03c7fb",
          "callPart": 276,
          "resultPart": 277,
          "literalArgsEqual": true,
          "ledgerOwner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-09 21:25:47.058+00",
          "durationMs": 11995,
          "derivedDispatchStart": "2026-10-09T21:25:35.063Z",
          "callTimestamp": "2026-10-09 17:25:33.081-04",
          "responseTimestamp": "2026-10-09 17:25:51.041-04",
          "callBeforeDispatchMs": 1982,
          "responseAfterSettleMs": 3983,
          "bounds": true,
          "noAmbiguity": true,
          "format": "toon",
          "textBlocks": null,
          "body": {
            "ok": true,
            "requested": true,
            "respawn": "queued",
            "budgetChars": 331360,
            "firstPromptSource": "continuation-note",
            "staleCheckpoints": [],
            "openOwnerQuestion": false,
            "priorRespawn": {
              "outcome": "pending",
              "reason": "busy-gate-expired",
              "ts": "2026-10-09T21:19:08.921Z",
              "ageMs": 397366,
              "capMs": 360000
            },
            "note": "Carry-respawn QUEUED — not performed yet. The host cuts this process only once your pty goes QUIET at a clean boundary, then respawns your successor on the deterministic carry document. It re-polls for a few minutes and can terminally DROP the carry — an interactive back-and-forth, or steady output, can supersede it indefinitely. So: wrap up and go quiet now, but FLUSH durable state first (work_items:checkpoint / loop:checkpoint / facts:assert) rather than relying on the cut. If you are still here on your next turn, it did not happen — re-request at the next clean stopping point instead of waiting. ⚠ prior-respawn-STILL-PENDING: an earlier carry-respawn is still awaiting its cut or first-turn delivery (host recorded `busy-gate-expired` 7m ago). This request SUPERSEDES it — the in-flight re-poll adopts this newer carry document — but the cut still only fires once your pty actually goes quiet.",
            "See also": "config:set-compaction-limit (tune when this fires)",
            "ℹ served by build cc28152984 (up 31m) — this host runs the code it booted with; source you read at HEAD/staging may be NEWER than the build that executed this call, so a defect still reproducing is not evidence its fix is broken until dev": "pipeline_position confirms this build contains it."
          },
          "state": "queued",
          "statusAgrees": true,
          "accepted": true,
          "sourceComplete": true
        }
      ],
      "rejected": [],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null
    },
    {
      "owner": "su-ba80f2f7-46f6-4aec-b99a-21e02460933f",
      "request_id": "34926174",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a1227a-27b3-79c3-990b-b101d7ea9a6c",
          "callPart": 127,
          "resultPart": 128,
          "literalArgsEqual": true,
          "ledgerOwner": "su-ba80f2f7-46f6-4aec-b99a-21e02460933f",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-09 21:26:33.72+00",
          "durationMs": 12753,
          "derivedDispatchStart": "2026-10-09T21:26:20.967Z",
          "callTimestamp": "2026-10-09 17:26:19.179-04",
          "responseTimestamp": "2026-10-09 17:26:38.759-04",
          "callBeforeDispatchMs": 1788,
          "responseAfterSettleMs": 5039,
          "bounds": true,
          "noAmbiguity": true,
          "format": "toon",
          "textBlocks": 2,
          "body": {
            "ok": true,
            "requested": true,
            "respawn": "queued",
            "budgetChars": 331360,
            "firstPromptSource": "continuation-note",
            "staleCheckpoints": [],
            "openOwnerQuestion": false,
            "priorRespawn": {
              "outcome": "delivered",
              "ts": "2026-10-09T21:07:41.293Z",
              "ageMs": 1131531,
              "capMs": null
            },
            "note": "Carry-respawn QUEUED — not performed yet. The host cuts this process only once your pty goes QUIET at a clean boundary, then respawns your successor on the deterministic carry document. It re-polls for a few minutes and can terminally DROP the carry — an interactive back-and-forth, or steady output, can supersede it indefinitely. So: wrap up and go quiet now, but FLUSH durable state first (work_items:checkpoint / loop:checkpoint / facts:assert) rather than relying on the cut. If you are still here on your next turn, it did not happen — re-request at the next clean stopping point instead of waiting."
          },
          "state": "queued",
          "statusAgrees": true,
          "accepted": true,
          "sourceComplete": true
        }
      ],
      "rejected": [],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null
    },
    {
      "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
      "request_id": "34932173",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a1228a-51bb-7100-b09e-114c38bf3712",
          "callPart": 135,
          "resultPart": 136,
          "literalArgsEqual": true,
          "ledgerOwner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-09 21:37:08.769+00",
          "durationMs": 691,
          "derivedDispatchStart": "2026-10-09T21:37:08.078Z",
          "callTimestamp": "2026-10-09T21:37:07.892+00:00",
          "responseTimestamp": "2026-10-09T21:37:11.209+00:00",
          "callBeforeDispatchMs": 186,
          "responseAfterSettleMs": 2440,
          "bounds": true,
          "noAmbiguity": true,
          "format": "toon",
          "textBlocks": null,
          "body": {
            "ok": true,
            "requested": true,
            "respawn": "queued",
            "budgetChars": 331360,
            "firstPromptSource": "continuation-note",
            "staleCheckpoints": [],
            "openOwnerQuestion": false,
            "priorRespawn": {
              "outcome": "delivered",
              "ts": "2026-10-09T21:21:19.071Z",
              "ageMs": 949676,
              "capMs": null
            },
            "note": "Carry-respawn QUEUED — not performed yet. The host cuts this process only once your pty goes QUIET at a clean boundary, then respawns your successor on the deterministic carry document. It re-polls for a few minutes and can terminally DROP the carry — an interactive back-and-forth, or steady output, can supersede it indefinitely. So: wrap up and go quiet now, but FLUSH durable state first (work_items:checkpoint / loop:checkpoint / facts:assert) rather than relying on the cut. If you are still here on your next turn, it did not happen — re-request at the next clean stopping point instead of waiting."
          },
          "state": "queued",
          "statusAgrees": true,
          "accepted": true,
          "sourceComplete": true
        }
      ],
      "rejected": [],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null
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
      "outcomeJoined": false,
      "assessmentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch1-424d5.json",
      "instrumentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold25-native-analysis-instrument-424d5.json"
    },
    {
      "owner": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
      "request_id": "34938104",
      "ledgerStatus": "ok",
      "candidates": 0,
      "exactArgumentMatches": 0,
      "pairs": [],
      "rejected": [],
      "receiptState": "unresolved",
      "acceptedUnique": false,
      "reason": "no-accepted-complete-pair",
      "cold24Reassessment": {
        "owner": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
        "request_id": "34938104",
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
      "cold25Assessment": {
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
      "cold26Assessment": {
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
              "links": [
                {
                  "yieldPart": 121,
                  "waitPart": 122,
                  "precedingCallPart": 120
                }
              ],
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
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch1-424d5.json",
        "outcomeJoined": false
      },
      "cold27Assessment": {
        "request_id": "34938104",
        "owner": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "acceptedPairCount": 0,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a1228c-7bc5-76c2-ac09-038120bb49b5",
            "callPart": 116,
            "resultPart": 117,
            "callTimestamp": "2026-10-09T21:45:28.528+00:00",
            "responseTimestamp": "2026-10-09T21:45:50.175+00:00",
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
            "nativeSession": "01a1228c-7bc5-76c2-ac09-038120bb49b5",
            "callPart": 118,
            "resultPart": 119,
            "callTimestamp": "2026-10-09T21:45:54.486+00:00",
            "responseTimestamp": "2026-10-09T21:46:08.093+00:00",
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
              "links": [
                {
                  "yieldPart": 121,
                  "waitPart": 122,
                  "precedingCallPart": 120
                }
              ],
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
          },
          {
            "nativeSession": "01a1228c-7bc5-76c2-ac09-038120bb49b5",
            "callPart": 124,
            "resultPart": 125,
            "callTimestamp": "2026-10-09T21:47:06.35+00:00",
            "responseTimestamp": "2026-10-09T21:47:31.299+00:00",
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
          }
        ],
        "outcomeJoined": false,
        "assessmentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold27-original45-lineage-augmentation-batch1-424d5.json",
        "sourceLocationAssessment": {
          "request_id": "34938104",
          "owner": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
          "ledger": {
            "id": "34938104",
            "tool_name": "session:request-compaction",
            "coord_owner_id": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
            "invoked_at": "2026-10-09 21:46:41.23+00",
            "duration_ms": 17686,
            "status": "ok",
            "args_json": {
              "focus": "Resume fleet lane fleet-launch-nonp2p-bug-drain-luna-max-0930-kinds. Continue held item EI-25532836303285911 from its work-item checkpoint. Trace 332829b3-2c86-446f-b093-bf03dab8b4fd shows work_items:checkpoint invoke 71,535 ms, deadline 55,142 ms, resultDoor 1 ms; reporter later read the writes as landed. Do not replay peer-owned items. Exact slow handler substep and durable fix remain unknown; first identify a safe phase-level measurement or self-owned reproduction, then fix with a regression guard.",
              "autoContinue": true
            }
          },
          "sourceRefs": [
            "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch1-424d5.json"
          ],
          "nativeSessions": [
            "01a1228c-7bc5-76c2-ac09-038120bb49b5"
          ],
          "originalCandidateCount": 5,
          "lineageCount": 11,
          "unofferedToolUses": [],
          "scopedLocationsMissing": true,
          "outcomeJoined": false
        }
      }
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
      "outcomeJoined": false,
      "assessmentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch1-424d5.json",
      "instrumentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold25-native-analysis-instrument-424d5.json"
    },
    {
      "owner": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
      "request_id": "34962872",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a122c3-b67b-7e12-a835-3aae3548eb00",
          "callPart": 79,
          "resultPart": 80,
          "literalArgsEqual": true,
          "ledgerOwner": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-09 22:34:27.609+00",
          "durationMs": 785,
          "derivedDispatchStart": "2026-10-09T22:34:26.824Z",
          "callTimestamp": "2026-10-09T22:34:26.518+00:00",
          "responseTimestamp": "2026-10-09T22:34:27.835+00:00",
          "callBeforeDispatchMs": 306,
          "responseAfterSettleMs": 226,
          "bounds": true,
          "noAmbiguity": true,
          "format": "toon",
          "textBlocks": null,
          "body": {
            "ok": true,
            "requested": true,
            "respawn": "queued",
            "budgetChars": 331360,
            "firstPromptSource": "continuation-note",
            "staleCheckpoints": [],
            "openOwnerQuestion": false,
            "priorRespawn": {
              "outcome": "dropped",
              "reason": "superseded",
              "ts": "2026-10-09T21:48:23.034Z",
              "ageMs": 2764545,
              "capMs": null
            },
            "note": "Carry-respawn QUEUED — not performed yet. The host cuts this process only once your pty goes QUIET at a clean boundary, then respawns your successor on the deterministic carry document. It re-polls for a few minutes and can terminally DROP the carry — an interactive back-and-forth, or steady output, can supersede it indefinitely. So: wrap up and go quiet now, but FLUSH durable state first (work_items:checkpoint / loop:checkpoint / facts:assert) rather than relying on the cut. If you are still here on your next turn, it did not happen — re-request at the next clean stopping point instead of waiting. ⚠ prior-respawn-DROPPED: your PREVIOUS carry continuation was not delivered — the host recorded `respawn-carry-dropped` (reason: superseded) 46m ago. The successor process may already exist: spawning and submitting its first turn are separate steps. Verify the native continuation rather than the acknowledgement; keep flushing state durably (work_items:checkpoint / loop:checkpoint) rather than relying on the carry."
          },
          "state": "queued",
          "statusAgrees": true,
          "accepted": true,
          "sourceComplete": true
        }
      ],
      "rejected": [],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null
    },
    {
      "owner": "su-82c46308-5eb9-4237-9d2d-950d322576c4",
      "request_id": "34967591",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a122c4-d22d-72b3-8c37-5ef6c96c94bb",
          "callPart": 80,
          "resultPart": 81,
          "literalArgsEqual": true,
          "ledgerOwner": "su-82c46308-5eb9-4237-9d2d-950d322576c4",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-09 22:44:15.679+00",
          "durationMs": 1391,
          "derivedDispatchStart": "2026-10-09T22:44:14.288Z",
          "callTimestamp": "2026-10-09T22:44:14.079+00:00",
          "responseTimestamp": "2026-10-09T22:44:17.1+00:00",
          "callBeforeDispatchMs": 209,
          "responseAfterSettleMs": 1421,
          "bounds": true,
          "noAmbiguity": true,
          "error": "no-leading-json-format-or-complete-json-stream",
          "state": "unclassified",
          "statusAgrees": false,
          "accepted": false,
          "sourceComplete": false
        }
      ],
      "rejected": [],
      "receiptState": "unresolved",
      "acceptedUnique": false,
      "reason": "no-accepted-complete-pair",
      "cold24Reassessment": {
        "owner": "su-82c46308-5eb9-4237-9d2d-950d322576c4",
        "request_id": "34967591",
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
      },
      "cold25Assessment": {
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
      },
      "cold26Assessment": {
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
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch1-424d5.json",
        "outcomeJoined": false
      },
      "cold27Assessment": {
        "request_id": "34967591",
        "owner": "su-82c46308-5eb9-4237-9d2d-950d322576c4",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "acceptedPairCount": 0,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a122c4-d22d-72b3-8c37-5ef6c96c94bb",
            "callPart": 76,
            "resultPart": 77,
            "callTimestamp": "2026-10-09T22:43:39.8+00:00",
            "responseTimestamp": "2026-10-09T22:43:43.59+00:00",
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
            "nativeSession": "01a122c4-d22d-72b3-8c37-5ef6c96c94bb",
            "callPart": 78,
            "resultPart": 79,
            "callTimestamp": "2026-10-09T22:44:00.571+00:00",
            "responseTimestamp": "2026-10-09T22:44:02.072+00:00",
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
        "outcomeJoined": false,
        "assessmentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold27-original45-lineage-augmentation-batch1-424d5.json",
        "sourceLocationAssessment": {
          "request_id": "34967591",
          "owner": "su-82c46308-5eb9-4237-9d2d-950d322576c4",
          "ledger": {
            "id": "34967591",
            "tool_name": "session:request-compaction",
            "coord_owner_id": "su-82c46308-5eb9-4237-9d2d-950d322576c4",
            "invoked_at": "2026-10-09 22:44:15.679+00",
            "duration_ms": 1391,
            "status": "ok",
            "args_json": {
              "focus": "Continue the nonp2p-bug-drain-luna-max-0930 fleet-member lane only. Reorient first; held items EI-25339497913821856 (historical /tmp ENOSPC producer still unknown; current bounded sample is non-causal) and EI-25435626316100952 (original plans:get-spec-evidence 55s timeout still unexplained; same limit=30 three-ID retry succeeded with 19 rows; source measurement path identified but not timed). Exact-owner claim spec remains fleet revision 12 / maxConcurrentClaims=2, leader inbox empty, no disposition/event key. Do not scheduler:get_next until leader changes cap. Loop checkpoint 058fb8f3ba58 is verified; check ledgers are full, latest evidence in work-item checkpoint heads.",
              "autoContinue": true
            }
          },
          "sourceRefs": [
            "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch1-424d5.json"
          ],
          "nativeSessions": [
            "01a122c4-d22d-72b3-8c37-5ef6c96c94bb"
          ],
          "originalCandidateCount": 3,
          "lineageCount": 7,
          "unofferedToolUses": [],
          "scopedLocationsMissing": true,
          "outcomeJoined": false
        }
      }
    },
    {
      "owner": "su-ddb4cbf4-2581-4f7c-8d6a-efbb712bd295",
      "request_id": "34967597",
      "ledgerStatus": "ok",
      "candidates": 0,
      "exactArgumentMatches": 0,
      "pairs": [],
      "rejected": [],
      "receiptState": "unresolved",
      "acceptedUnique": false,
      "reason": "no-accepted-complete-pair",
      "cold24Reassessment": {
        "owner": "su-ddb4cbf4-2581-4f7c-8d6a-efbb712bd295",
        "request_id": "34967597",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [],
        "acceptedPairCount": 0,
        "outcomeJoined": false
      },
      "cold25Assessment": {
        "request_id": "34967597",
        "owner": "su-ddb4cbf4-2581-4f7c-8d6a-efbb712bd295",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [],
        "acceptedPairCount": 0,
        "outcomeJoined": false
      },
      "cold26Assessment": {
        "request_id": "34967597",
        "owner": "su-ddb4cbf4-2581-4f7c-8d6a-efbb712bd295",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [],
        "acceptedPairCount": 0,
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch2-424d5.json",
        "outcomeJoined": false
      },
      "cold27Assessment": {
        "request_id": "34967597",
        "owner": "su-ddb4cbf4-2581-4f7c-8d6a-efbb712bd295",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "acceptedPairCount": 0,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a122c4-ab61-7441-ae2f-4df2cabf0193",
            "callPart": 101,
            "resultPart": 102,
            "callTimestamp": "2026-10-09T22:44:12.513+00:00",
            "responseTimestamp": "2026-10-09T22:44:16.884+00:00",
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
          },
          {
            "nativeSession": "01a122c4-ab61-7441-ae2f-4df2cabf0193",
            "callPart": 103,
            "resultPart": 104,
            "callTimestamp": "2026-10-09T22:45:02.268+00:00",
            "responseTimestamp": "2026-10-09T22:45:02.997+00:00",
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
        "outcomeJoined": false,
        "assessmentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold27-original45-lineage-augmentation-batch1-424d5.json",
        "sourceLocationAssessment": {
          "request_id": "34967597",
          "owner": "su-ddb4cbf4-2581-4f7c-8d6a-efbb712bd295",
          "ledger": {
            "id": "34967597",
            "tool_name": "session:request-compaction",
            "coord_owner_id": "su-ddb4cbf4-2581-4f7c-8d6a-efbb712bd295",
            "invoked_at": "2026-10-09 22:44:16.691+00",
            "duration_ms": 736,
            "status": "ok",
            "args_json": {
              "focus": "Resume the active nonp2p-bug-drain fleet lane. The su-88909 inbox message was already answered; verify from coord:inbox/unanswered state before any reply. The inbox-wake await is a once:false standing watch and was preserved after cancel refusal. Reorient, check capacity, then advance one active bug claim.",
              "continueNote": "Continue the fleet-only bug drain. Do not duplicate the replied storage message or monitor the peer's storage check. Current active claims: EI-25492589519483281 and EI-25508393807049455; checkpoints are fresh from this turn. The result-door alias test succeeded, but its original failure remains unresolved."
            }
          },
          "sourceRefs": [
            "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch2-424d5.json"
          ],
          "nativeSessions": [
            "01a122c4-ab61-7441-ae2f-4df2cabf0193"
          ],
          "originalCandidateCount": 2,
          "lineageCount": 5,
          "unofferedToolUses": [],
          "scopedLocationsMissing": true,
          "outcomeJoined": false
        }
      }
    },
    {
      "owner": "su-82c46308-5eb9-4237-9d2d-950d322576c4",
      "request_id": "34979247",
      "ledgerStatus": "ok",
      "candidates": 0,
      "exactArgumentMatches": 0,
      "pairs": [],
      "rejected": [],
      "receiptState": "unresolved",
      "acceptedUnique": false,
      "reason": "no-accepted-complete-pair",
      "cold24Reassessment": {
        "owner": "su-82c46308-5eb9-4237-9d2d-950d322576c4",
        "request_id": "34979247",
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
      "cold25Assessment": {
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
      "cold26Assessment": {
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
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch2-424d5.json",
        "outcomeJoined": false
      },
      "cold27Assessment": {
        "request_id": "34979247",
        "owner": "su-82c46308-5eb9-4237-9d2d-950d322576c4",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "acceptedPairCount": 0,
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
          },
          {
            "nativeSession": "01a122ec-4cda-7080-9411-78e5617480bc",
            "callPart": 4,
            "resultPart": 5,
            "callTimestamp": "2026-10-09T23:08:33.453+00:00",
            "responseTimestamp": "2026-10-09T23:08:33.551+00:00",
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
        "outcomeJoined": false,
        "assessmentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold27-original45-lineage-augmentation-batch2-424d5.json",
        "sourceLocationAssessment": {
          "request_id": "34979247",
          "owner": "su-82c46308-5eb9-4237-9d2d-950d322576c4",
          "ledger": {
            "id": "34979247",
            "tool_name": "session:request-compaction",
            "coord_owner_id": "su-82c46308-5eb9-4237-9d2d-950d322576c4",
            "invoked_at": "2026-10-09 23:07:33.987+00",
            "duration_ms": 2936,
            "status": "ok",
            "args_json": {
              "focus": "Resume EI-25435626316100952 after instrumentation checkpoint: retrieve the already-stored dev:pipeline_position spill to extract currentBuildTestRoute, then exercise stage timings on staging if the route allows. Keep EI-25339497913821856 historical ENOSPC producer unresolved pending same-time writer evidence. Fleet cap remains rev12/maxConcurrentClaims=2; recheck leader inbox and cap at next loop wake; do not scheduler:get_next without a changed cap. The gate is held live by su-88909c8d-d46f-4a5d-9473-d0220bf07af2; evidence was sent once, so do not reread gate status.",
              "autoContinue": true
            }
          },
          "sourceRefs": [
            "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch2-424d5.json"
          ],
          "nativeSessions": [
            "01a122d6-ff62-75c3-a4ee-384dd3040a57",
            "01a122ec-4cda-7080-9411-78e5617480bc"
          ],
          "originalCandidateCount": 2,
          "lineageCount": 6,
          "unofferedToolUses": [
            {
              "session_id": "01a122ec-4cda-7080-9411-78e5617480bc",
              "part_idx": 6,
              "tool_name": "exec",
              "chars": 334,
              "clipped": false
            }
          ],
          "scopedLocationsMissing": true,
          "outcomeJoined": false
        }
      }
    },
    {
      "owner": "su-ba80f2f7-46f6-4aec-b99a-21e02460933f",
      "request_id": "34980575",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a122d9-d539-7ed1-918a-41bcc5b9f9c4",
          "callPart": 113,
          "resultPart": 114,
          "literalArgsEqual": true,
          "ledgerOwner": "su-ba80f2f7-46f6-4aec-b99a-21e02460933f",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-09 23:09:37.086+00",
          "durationMs": 711,
          "derivedDispatchStart": "2026-10-09T23:09:36.375Z",
          "callTimestamp": "2026-10-09T23:09:35.497+00:00",
          "responseTimestamp": "2026-10-09T23:09:37.298+00:00",
          "callBeforeDispatchMs": 878,
          "responseAfterSettleMs": 212,
          "bounds": true,
          "noAmbiguity": true,
          "error": "no-leading-json-format-or-complete-json-stream",
          "state": "unclassified",
          "statusAgrees": false,
          "accepted": false,
          "sourceComplete": false
        }
      ],
      "rejected": [],
      "receiptState": "unresolved",
      "acceptedUnique": false,
      "reason": "no-accepted-complete-pair",
      "cold24Reassessment": {
        "owner": "su-ba80f2f7-46f6-4aec-b99a-21e02460933f",
        "request_id": "34980575",
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
      "cold25Assessment": {
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
      "cold26Assessment": {
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
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch2-424d5.json",
        "outcomeJoined": false
      },
      "cold27Assessment": {
        "request_id": "34980575",
        "owner": "su-ba80f2f7-46f6-4aec-b99a-21e02460933f",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "acceptedPairCount": 0,
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
          },
          {
            "nativeSession": "01a122d9-d539-7ed1-918a-41bcc5b9f9c4",
            "callPart": 115,
            "resultPart": 116,
            "callTimestamp": "2026-10-09T23:09:44.004+00:00",
            "responseTimestamp": "2026-10-09T23:09:45.592+00:00",
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
            "callPart": 117,
            "resultPart": 118,
            "callTimestamp": "2026-10-09T23:10:01.149+00:00",
            "responseTimestamp": "2026-10-09T23:10:11.712+00:00",
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
        "outcomeJoined": false,
        "assessmentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold27-original45-lineage-augmentation-batch2-424d5.json",
        "sourceLocationAssessment": {
          "request_id": "34980575",
          "owner": "su-ba80f2f7-46f6-4aec-b99a-21e02460933f",
          "ledger": {
            "id": "34980575",
            "tool_name": "session:request-compaction",
            "coord_owner_id": "su-ba80f2f7-46f6-4aec-b99a-21e02460933f",
            "invoked_at": "2026-10-09 23:09:37.086+00",
            "duration_ms": 711,
            "status": "ok",
            "args_json": {
              "focus": "Continue held EI-25527787356902783. Root cause remains unknown; confirm the historical :9071 proxy upstream and serving generation, compare the direct tools:find schema with the handler that rejected resultLimitPerPool, then make a durable fix and recurrence guard if confirmed.",
              "autoContinue": true
            }
          },
          "sourceRefs": [
            "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch2-424d5.json"
          ],
          "nativeSessions": [
            "01a122d9-d539-7ed1-918a-41bcc5b9f9c4"
          ],
          "originalCandidateCount": 4,
          "lineageCount": 9,
          "unofferedToolUses": [],
          "scopedLocationsMissing": true,
          "outcomeJoined": false
        }
      }
    },
    {
      "owner": "su-312c90f2-a3bd-4c92-ac4e-4eae40ae2647",
      "request_id": "34983377",
      "acceptedUnique": true,
      "completeOriginalPair": true,
      "receiptState": "queued",
      "pairs": [
        {
          "nativeSession": "01a122e2-3803-77b0-9417-4b18e4d73bf4",
          "callPart": 97,
          "resultPart": 98,
          "callTimestamp": "2026-10-09T23:13:41.025+00:00",
          "responseTimestamp": "2026-10-09T23:13:51.31+00:00",
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
          "nativeSession": "01a122e2-3803-77b0-9417-4b18e4d73bf4",
          "callPart": 99,
          "resultPart": 100,
          "callTimestamp": "2026-10-09T23:14:01.203+00:00",
          "responseTimestamp": "2026-10-09T23:14:32.445+00:00",
          "mechanisms": [
            "invoke"
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
          "nativeSession": "01a122e2-3803-77b0-9417-4b18e4d73bf4",
          "callPart": 99,
          "resultPart": 102,
          "callTimestamp": "2026-10-09T23:14:01.203+00:00",
          "responseTimestamp": "2026-10-09T23:14:41.628+00:00",
          "mechanisms": [
            "invoke"
          ],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "41",
            "yieldPart": 100,
            "waitPart": 101,
            "originalCallPart": 99
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
      "outcomeJoined": false,
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-native-assessment-batch2-424d5.json"
    },
    {
      "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
      "request_id": "34992385",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 0,
      "pairs": [
        {
          "nativeSession": "01a122ee-350a-77d0-b4b1-f2b553271268",
          "callPart": 117,
          "resultPart": 118,
          "callTimestamp": "2026-10-09T23:30:42.854+00:00",
          "responseTimestamp": "2026-10-09T23:30:44.346+00:00",
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
          "receiptState": "queued",
          "statusAgrees": true,
          "format": "toon",
          "requested": true,
          "respawn": "queued",
          "completeOriginalPair": true,
          "accepted": true,
          "state": "queued"
        }
      ],
      "rejected": [
        {
          "session": "01a122ee-350a-77d0-b4b1-f2b553271268",
          "part": 117,
          "reason": "Error: nonliteral argument:Identifier"
        }
      ],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null,
      "priorAssessment": {
        "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
        "request_id": "34992385",
        "ledgerStatus": "ok",
        "candidates": 1,
        "exactArgumentMatches": 0,
        "pairs": [],
        "rejected": [
          {
            "session": "01a122ee-350a-77d0-b4b1-f2b553271268",
            "part": 117,
            "reason": "Error: nonliteral argument:Identifier"
          }
        ],
        "receiptState": "unresolved",
        "acceptedUnique": false,
        "reason": "no-accepted-complete-pair"
      },
      "custodySource": "audits/parked-agent-resumption-2026-10-09/r13-cold23-remaining-direct-originals-424d5.json",
      "currentSourceAssessment": {
        "request_id": "34992385",
        "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
        "completeOriginalPair": true,
        "pairs": [
          {
            "nativeSession": "01a122ee-350a-77d0-b4b1-f2b553271268",
            "callPart": 117,
            "resultPart": 118,
            "callTimestamp": "2026-10-09T23:30:42.854+00:00",
            "responseTimestamp": "2026-10-09T23:30:44.346+00:00",
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
      }
    },
    {
      "owner": "su-ba80f2f7-46f6-4aec-b99a-21e02460933f",
      "request_id": "34993138",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 0,
      "pairs": [],
      "rejected": [
        {
          "session": "01a122ee-ee80-77b3-9aed-03658f2afb68",
          "part": 101,
          "reason": "argument-mismatch"
        }
      ],
      "receiptState": "unresolved",
      "acceptedUnique": false,
      "reason": "no-accepted-complete-pair",
      "cold24Reassessment": {
        "owner": "su-ba80f2f7-46f6-4aec-b99a-21e02460933f",
        "request_id": "34993138",
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
      "cold25Assessment": {
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
      "cold26Assessment": {
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
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch2-424d5.json",
        "outcomeJoined": false
      },
      "cold27Assessment": {
        "request_id": "34993138",
        "owner": "su-ba80f2f7-46f6-4aec-b99a-21e02460933f",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "acceptedPairCount": 0,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a122ee-ee80-77b3-9aed-03658f2afb68",
            "callPart": 99,
            "resultPart": 100,
            "callTimestamp": "2026-10-09T23:31:40.295+00:00",
            "responseTimestamp": "2026-10-09T23:31:42.228+00:00",
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
          },
          {
            "nativeSession": "01a12302-9220-7a31-94cd-e744f4253db3",
            "callPart": 4,
            "resultPart": 5,
            "callTimestamp": "2026-10-09T23:32:26.675+00:00",
            "responseTimestamp": "2026-10-09T23:32:26.755+00:00",
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
            "nativeSession": "01a12302-9220-7a31-94cd-e744f4253db3",
            "callPart": 6,
            "resultPart": 7,
            "callTimestamp": "2026-10-09T23:32:36.693+00:00",
            "responseTimestamp": "2026-10-09T23:32:39.016+00:00",
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
            "nativeSession": "01a12302-9220-7a31-94cd-e744f4253db3",
            "callPart": 8,
            "resultPart": 9,
            "callTimestamp": "2026-10-09T23:32:42.048+00:00",
            "responseTimestamp": "2026-10-09T23:32:42.942+00:00",
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
            "nativeSession": "01a12302-9220-7a31-94cd-e744f4253db3",
            "callPart": 11,
            "resultPart": 12,
            "callTimestamp": "2026-10-09T23:32:55.621+00:00",
            "responseTimestamp": "2026-10-09T23:33:06.771+00:00",
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
          }
        ],
        "outcomeJoined": false,
        "assessmentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold27-original45-lineage-augmentation-batch2-424d5.json",
        "sourceLocationAssessment": {
          "request_id": "34993138",
          "owner": "su-ba80f2f7-46f6-4aec-b99a-21e02460933f",
          "ledger": {
            "id": "34993138",
            "tool_name": "session:request-compaction",
            "coord_owner_id": "su-ba80f2f7-46f6-4aec-b99a-21e02460933f",
            "invoked_at": "2026-10-09 23:32:04.106+00",
            "duration_ms": 786,
            "status": "ok",
            "args_json": {
              "focus": "Continue EI-25527787356902783 from its latest checkpoint hash e4fd49573b4a. Root cause is now measured: tools:find row 34829192 served on port-3170/build ad00f10153 and advertised resultLimitPerPool; ptool dev:pg_health row 34829982 came through client :9071 and was served on port-3070/build d740fc3802; retry row 34830174 succeeded on that same :3070 build with localOnly. Source at ad00f exposes resultLimitPerPool; d740fc release handler accepts localOnly only. Workspace guardrail key guard-rail:ptool-schema-route-consistency is asserted with a recheck probe. No code/tests needed. First verify coord:whoami, re-read work_items:get resume for claim freshness, then close the item as resolved with required nested rootCauseVerification and testsRun/filesChanged evidence. Check loop status and continue only after the item is terminal.",
              "autoContinue": true
            }
          },
          "sourceRefs": [
            "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch2-424d5.json"
          ],
          "nativeSessions": [
            "01a122ee-ee80-77b3-9aed-03658f2afb68",
            "01a12302-9220-7a31-94cd-e744f4253db3"
          ],
          "originalCandidateCount": 6,
          "lineageCount": 15,
          "unofferedToolUses": [
            {
              "session_id": "01a12302-9220-7a31-94cd-e744f4253db3",
              "part_idx": 13,
              "tool_name": "exec",
              "chars": 444,
              "clipped": false
            }
          ],
          "scopedLocationsMissing": true,
          "outcomeJoined": false
        }
      }
    },
    {
      "owner": "su-ddb4cbf4-2581-4f7c-8d6a-efbb712bd295",
      "request_id": "34995559",
      "ledgerStatus": "ok",
      "candidates": 0,
      "exactArgumentMatches": 0,
      "pairs": [],
      "rejected": [],
      "receiptState": "unresolved",
      "acceptedUnique": false,
      "reason": "no-accepted-complete-pair",
      "cold24Reassessment": {
        "owner": "su-ddb4cbf4-2581-4f7c-8d6a-efbb712bd295",
        "request_id": "34995559",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [],
        "acceptedPairCount": 0,
        "outcomeJoined": false
      },
      "cold25Assessment": {
        "request_id": "34995559",
        "owner": "su-ddb4cbf4-2581-4f7c-8d6a-efbb712bd295",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [],
        "acceptedPairCount": 0,
        "outcomeJoined": false
      },
      "cold26Assessment": {
        "request_id": "34995559",
        "owner": "su-ddb4cbf4-2581-4f7c-8d6a-efbb712bd295",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [],
        "acceptedPairCount": 0,
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch2-424d5.json",
        "outcomeJoined": false
      },
      "cold27Assessment": {
        "request_id": "34995559",
        "owner": "su-ddb4cbf4-2581-4f7c-8d6a-efbb712bd295",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "acceptedPairCount": 0,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a122ef-e794-7141-ab72-5d02dedba04e",
            "callPart": 168,
            "resultPart": 169,
            "callTimestamp": "2026-10-09T23:37:37.573+00:00",
            "responseTimestamp": "2026-10-09T23:37:42.887+00:00",
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
          },
          {
            "nativeSession": "01a12308-16d4-7b32-8c56-c080e0f308f7",
            "callPart": 4,
            "resultPart": 5,
            "callTimestamp": "2026-10-09T23:38:23.319+00:00",
            "responseTimestamp": "2026-10-09T23:38:23.65+00:00",
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
            "nativeSession": "01a12308-16d4-7b32-8c56-c080e0f308f7",
            "callPart": 6,
            "resultPart": 7,
            "callTimestamp": "2026-10-09T23:38:27.038+00:00",
            "responseTimestamp": "2026-10-09T23:38:27.1+00:00",
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
            "nativeSession": "01a12308-16d4-7b32-8c56-c080e0f308f7",
            "callPart": 8,
            "resultPart": 9,
            "callTimestamp": "2026-10-09T23:38:29.374+00:00",
            "responseTimestamp": "2026-10-09T23:38:29.457+00:00",
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
            "nativeSession": "01a12308-16d4-7b32-8c56-c080e0f308f7",
            "callPart": 10,
            "resultPart": 11,
            "callTimestamp": "2026-10-09T23:38:32.679+00:00",
            "responseTimestamp": "2026-10-09T23:38:36.206+00:00",
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
            "nativeSession": "01a12308-16d4-7b32-8c56-c080e0f308f7",
            "callPart": 12,
            "resultPart": 13,
            "callTimestamp": "2026-10-09T23:38:38.492+00:00",
            "responseTimestamp": "2026-10-09T23:38:39.022+00:00",
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
          }
        ],
        "outcomeJoined": false,
        "assessmentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold27-original45-lineage-augmentation-batch2-424d5.json",
        "sourceLocationAssessment": {
          "request_id": "34995559",
          "owner": "su-ddb4cbf4-2581-4f7c-8d6a-efbb712bd295",
          "ledger": {
            "id": "34995559",
            "tool_name": "session:request-compaction",
            "coord_owner_id": "su-ddb4cbf4-2581-4f7c-8d6a-efbb712bd295",
            "invoked_at": "2026-10-09 23:37:41.28+00",
            "duration_ms": 1085,
            "status": "ok",
            "args_json": {
              "focus": "Continue fleet nonp2p-bug-drain-luna-max-0930 as su-ddb4cbf4-2581-4f7c-8d6a-efbb712bd295. Active claims remain EI-25508393807049455 and EI-25492589519483281 (scheduler cap 2/2). EI-254925 checkpoint was corrected: source rows 34714317 and 34714325 share timestamp 14:45:02.275Z; exact traces are 7a076c12-dd8a-4722-86f5-a4e1f5c6afd4 and 7ae7e9da-fb84-42b8-a2c9-f8368124c861. The first trace was mistyped in the prior checkpoint/focus; the new checkpoint and loop note correct it. Next: inspect both traces and acquisition-ticket evidence for process 3911170; root cause of 7.5s org-admin begin timeout remains unknown. ptool checkpoint failed before operator connection with ENOSPC on /tmp (20,480 bytes free, 496,794 inodes); captured as EI-25546790103859450 and direct MCP checkpoint/loop writes succeeded. Identify the temporary filesystem consumer if ENOSPC persists. Standing inbox wake await 252411 is still active, with no outstanding deliveries. Resume from the new loop checkpoint and its corrected trace IDs.",
              "autoContinue": true
            }
          },
          "sourceRefs": [
            "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch2-424d5.json"
          ],
          "nativeSessions": [
            "01a122ef-e794-7141-ab72-5d02dedba04e",
            "01a12308-16d4-7b32-8c56-c080e0f308f7"
          ],
          "originalCandidateCount": 6,
          "lineageCount": 14,
          "unofferedToolUses": [
            {
              "session_id": "01a12308-16d4-7b32-8c56-c080e0f308f7",
              "part_idx": 14,
              "tool_name": "exec",
              "chars": 251,
              "clipped": false
            }
          ],
          "scopedLocationsMissing": true,
          "outcomeJoined": false
        }
      }
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
      "outcomeJoined": false,
      "assessmentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch2-424d5.json",
      "instrumentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold25-native-analysis-instrument-424d5.json"
    },
    {
      "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
      "request_id": "35002236",
      "ledgerStatus": "ok",
      "candidates": 0,
      "exactArgumentMatches": 0,
      "pairs": [],
      "rejected": [],
      "receiptState": "unresolved",
      "acceptedUnique": false,
      "reason": "no-accepted-complete-pair",
      "cold24Reassessment": {
        "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
        "request_id": "35002236",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [],
        "acceptedPairCount": 0,
        "outcomeJoined": false
      },
      "cold25Assessment": {
        "request_id": "35002236",
        "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [],
        "acceptedPairCount": 0,
        "outcomeJoined": false
      },
      "cold26Assessment": {
        "request_id": "35002236",
        "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [],
        "acceptedPairCount": 0,
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch2-424d5.json",
        "outcomeJoined": false
      },
      "cold27Assessment": {
        "request_id": "35002236",
        "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "acceptedPairCount": 0,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a12301-650c-73c2-af6d-661ef6de7e01",
            "callPart": 150,
            "resultPart": 151,
            "callTimestamp": "2026-10-09T23:50:34.264+00:00",
            "responseTimestamp": "2026-10-09T23:50:39.341+00:00",
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
        "outcomeJoined": false,
        "assessmentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold27-original45-lineage-augmentation-batch2-424d5.json",
        "sourceLocationAssessment": {
          "request_id": "35002236",
          "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
          "ledger": {
            "id": "35002236",
            "tool_name": "session:request-compaction",
            "coord_owner_id": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
            "invoked_at": "2026-10-09 23:50:39.075+00",
            "duration_ms": 669,
            "status": "ok",
            "args_json": {
              "focus": "Continue EI-25536986894028197 in fleet nonp2p-bug-drain-luna-max-0930. Identity and claim were reverified; work-item and cold-loop checkpoints are current. Await 259394 for resource:released:git-sync:papercusp (expires 23:57:44Z). After the named lock releases, retry only the sanctioned ptool git-sync:run --url=http://127.0.0.1:3271, inspect the reported seven-file content-check quarantine if sync remains blocked, then confirm the accepted source SHA and staging runtime containment before collecting fresh same-host progress/settlement traces. The focused scratch-gc test passed 56/56; slow spill causality remains unproven.",
              "autoContinue": true
            }
          },
          "sourceRefs": [
            "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch2-424d5.json"
          ],
          "nativeSessions": [
            "01a12301-650c-73c2-af6d-661ef6de7e01"
          ],
          "originalCandidateCount": 1,
          "lineageCount": 3,
          "unofferedToolUses": [],
          "scopedLocationsMissing": true,
          "outcomeJoined": false
        }
      }
    },
    {
      "owner": "su-ddb4cbf4-2581-4f7c-8d6a-efbb712bd295",
      "request_id": "35005267",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a12308-16d4-7b32-8c56-c080e0f308f7",
          "callPart": 174,
          "resultPart": 175,
          "literalArgsEqual": true,
          "ledgerOwner": "su-ddb4cbf4-2581-4f7c-8d6a-efbb712bd295",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-09 23:56:59.599+00",
          "durationMs": 989,
          "derivedDispatchStart": "2026-10-09T23:56:58.610Z",
          "callTimestamp": "2026-10-09T23:56:57.196+00:00",
          "responseTimestamp": "2026-10-09T23:57:04.138+00:00",
          "callBeforeDispatchMs": 1414,
          "responseAfterSettleMs": 4539,
          "bounds": true,
          "noAmbiguity": true,
          "format": "toon",
          "textBlocks": null,
          "body": {
            "ok": true,
            "requested": true,
            "respawn": "queued",
            "budgetChars": 331360,
            "firstPromptSource": "continuation-note",
            "staleCheckpoints": [],
            "openOwnerQuestion": false,
            "priorRespawn": {
              "outcome": "delivered",
              "ts": "2026-10-09T23:38:21.230Z",
              "ageMs": 1118345,
              "capMs": null
            },
            "note": "Carry-respawn QUEUED — not performed yet. The host cuts this process only once your pty goes QUIET at a clean boundary, then respawns your successor on the deterministic carry document. It re-polls for a few minutes and can terminally DROP the carry — an interactive back-and-forth, or steady output, can supersede it indefinitely. So: wrap up and go quiet now, but FLUSH durable state first (work_items:checkpoint / loop:checkpoint / facts:assert) rather than relying on the cut. If you are still here on your next turn, it did not happen — re-request at the next clean stopping point instead of waiting."
          },
          "state": "queued",
          "statusAgrees": true,
          "accepted": true,
          "sourceComplete": true
        }
      ],
      "rejected": [],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null
    },
    {
      "owner": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
      "request_id": "35006152",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 0,
      "pairs": [
        {
          "nativeSession": "01a12309-a334-7de2-ba2d-b2e49d793aaa",
          "callPart": 144,
          "resultPart": 145,
          "callTimestamp": "2026-10-09T23:59:03.187+00:00",
          "responseTimestamp": "2026-10-09T23:59:05.93+00:00",
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
          "receiptState": "queued",
          "statusAgrees": true,
          "format": "toon",
          "requested": true,
          "respawn": "queued",
          "completeOriginalPair": true,
          "accepted": true,
          "state": "queued"
        }
      ],
      "rejected": [
        {
          "session": "01a12309-a334-7de2-ba2d-b2e49d793aaa",
          "part": 144,
          "reason": "Error: nonliteral property"
        }
      ],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null,
      "priorAssessment": {
        "owner": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
        "request_id": "35006152",
        "ledgerStatus": "ok",
        "candidates": 1,
        "exactArgumentMatches": 0,
        "pairs": [],
        "rejected": [
          {
            "session": "01a12309-a334-7de2-ba2d-b2e49d793aaa",
            "part": 144,
            "reason": "Error: nonliteral property"
          }
        ],
        "receiptState": "unresolved",
        "acceptedUnique": false,
        "reason": "no-accepted-complete-pair"
      },
      "custodySource": "audits/parked-agent-resumption-2026-10-09/r13-cold23-remaining-direct-originals-424d5.json",
      "currentSourceAssessment": {
        "request_id": "35006152",
        "owner": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
        "completeOriginalPair": true,
        "pairs": [
          {
            "nativeSession": "01a12309-a334-7de2-ba2d-b2e49d793aaa",
            "callPart": 144,
            "resultPart": 145,
            "callTimestamp": "2026-10-09T23:59:03.187+00:00",
            "responseTimestamp": "2026-10-09T23:59:05.93+00:00",
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
      }
    },
    {
      "owner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
      "request_id": "35007728",
      "ledgerStatus": "ok",
      "candidates": 0,
      "exactArgumentMatches": 0,
      "pairs": [],
      "rejected": [],
      "receiptState": "unresolved",
      "acceptedUnique": false,
      "reason": "no-accepted-complete-pair",
      "cold24Reassessment": {
        "owner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
        "request_id": "35007728",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [],
        "acceptedPairCount": 0,
        "outcomeJoined": false
      },
      "cold25Assessment": {
        "request_id": "35007728",
        "owner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [],
        "acceptedPairCount": 0,
        "outcomeJoined": false
      },
      "cold26Assessment": {
        "request_id": "35007728",
        "owner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [],
        "acceptedPairCount": 0,
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch2-424d5.json",
        "outcomeJoined": false
      },
      "cold27Assessment": {
        "request_id": "35007728",
        "owner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "acceptedPairCount": 0,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a12308-185e-7f41-bfec-9b7409dd18d3",
            "callPart": 135,
            "resultPart": 136,
            "callTimestamp": "2026-10-10T00:01:21.722+00:00",
            "responseTimestamp": "2026-10-10T00:01:23.159+00:00",
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
            "nativeSession": "01a12308-185e-7f41-bfec-9b7409dd18d3",
            "callPart": 137,
            "resultPart": 138,
            "callTimestamp": "2026-10-10T00:01:46.681+00:00",
            "responseTimestamp": "2026-10-10T00:01:47.791+00:00",
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
            "nativeSession": "01a12308-185e-7f41-bfec-9b7409dd18d3",
            "callPart": 140,
            "resultPart": 141,
            "callTimestamp": "2026-10-10T00:02:14.805+00:00",
            "responseTimestamp": "2026-10-10T00:02:20.924+00:00",
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
          },
          {
            "nativeSession": "01a1231e-4587-78c2-aa03-27c4229be312",
            "callPart": 4,
            "resultPart": 5,
            "callTimestamp": "2026-10-10T00:03:01.023+00:00",
            "responseTimestamp": "2026-10-10T00:03:01.151+00:00",
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
            "nativeSession": "01a1231e-4587-78c2-aa03-27c4229be312",
            "callPart": 6,
            "resultPart": 7,
            "callTimestamp": "2026-10-10T00:03:03.794+00:00",
            "responseTimestamp": "2026-10-10T00:03:06.434+00:00",
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
            "nativeSession": "01a1231e-4587-78c2-aa03-27c4229be312",
            "callPart": 8,
            "resultPart": 9,
            "callTimestamp": "2026-10-10T00:03:15.261+00:00",
            "responseTimestamp": "2026-10-10T00:03:15.348+00:00",
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
            "nativeSession": "01a1231e-4587-78c2-aa03-27c4229be312",
            "callPart": 10,
            "resultPart": 11,
            "callTimestamp": "2026-10-10T00:03:19.592+00:00",
            "responseTimestamp": "2026-10-10T00:03:21.664+00:00",
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
          }
        ],
        "outcomeJoined": false,
        "assessmentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold27-original45-lineage-augmentation-batch2-424d5.json",
        "sourceLocationAssessment": {
          "request_id": "35007728",
          "owner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
          "ledger": {
            "id": "35007728",
            "tool_name": "session:request-compaction",
            "coord_owner_id": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
            "invoked_at": "2026-10-10 00:02:20.661+00",
            "duration_ms": 805,
            "status": "ok",
            "args_json": {
              "focus": "Continue EI-25541385148400614. Unit test evidence: testing:runs row 20964684 passed 164 tests for the combined classifier on staging at 36b8e2d9e9dfde8acd73d2b2bb214d6966afd822 (dirty tree). SQL parity remains. Shared PG was correctly blocked at 1.67% headroom. Private pgvector/pgvector:pg18 is ready on tmpfs at loopback port 32785 in container papercusp-ei255413-pg-f0e98560. Retry only the SQL parity integration test with PAPERCUSP_TEST_PG_ADMIN_URL and source-map capture in /dev/shm/papercusp-classifier-final; inspect test/provenance evidence, stop only the owned container, then complete the item with structured rootCauseVerification.",
              "autoContinue": true
            }
          },
          "sourceRefs": [
            "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch2-424d5.json"
          ],
          "nativeSessions": [
            "01a12308-185e-7f41-bfec-9b7409dd18d3",
            "01a1231e-4587-78c2-aa03-27c4229be312"
          ],
          "originalCandidateCount": 7,
          "lineageCount": 17,
          "unofferedToolUses": [
            {
              "session_id": "01a1231e-4587-78c2-aa03-27c4229be312",
              "part_idx": 12,
              "tool_name": "exec",
              "chars": 1223,
              "clipped": false
            }
          ],
          "scopedLocationsMissing": true,
          "outcomeJoined": false
        }
      }
    },
    {
      "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
      "request_id": "35012964",
      "ledgerStatus": "ok",
      "candidates": 0,
      "exactArgumentMatches": 0,
      "pairs": [],
      "rejected": [],
      "receiptState": "unresolved",
      "acceptedUnique": false,
      "reason": "no-accepted-complete-pair",
      "cold24Reassessment": {
        "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
        "request_id": "35012964",
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
      "cold25Assessment": {
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
      "cold26Assessment": {
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
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch2-424d5.json",
        "outcomeJoined": false
      },
      "cold27Assessment": {
        "request_id": "35012964",
        "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "acceptedPairCount": 0,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a12315-8b95-7243-8949-1b20acf248cd",
            "callPart": 110,
            "resultPart": 111,
            "callTimestamp": "2026-10-10T00:13:39.584+00:00",
            "responseTimestamp": "2026-10-10T00:13:42.889+00:00",
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
          },
          {
            "nativeSession": "01a12315-8b95-7243-8949-1b20acf248cd",
            "callPart": 113,
            "resultPart": 114,
            "callTimestamp": "2026-10-10T00:14:10.182+00:00",
            "responseTimestamp": "2026-10-10T00:14:13.573+00:00",
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
        "outcomeJoined": false,
        "assessmentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold27-original45-lineage-augmentation-batch2-424d5.json",
        "sourceLocationAssessment": {
          "request_id": "35012964",
          "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
          "ledger": {
            "id": "35012964",
            "tool_name": "session:request-compaction",
            "coord_owner_id": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
            "invoked_at": "2026-10-10 00:13:42.729+00",
            "duration_ms": 644,
            "status": "ok",
            "args_json": {
              "focus": "Resume EI-25536986894028197 after resource:released:git-sync:papercusp. Verify owner/claim first only if control state changed; current task is registered and held. Recheck the resource lock immediately, run only sanctioned ptool git-sync:run if unheld, use the fresh outcome to distinguish current quarantine from retained/stale errors, then verify expected scratch-gc.ts source hash is on staging and staging runtime contains it before traceId-joined log collection. Loop await 259522; item and loop checkpoints just refreshed.",
              "autoContinue": true
            }
          },
          "sourceRefs": [
            "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch2-424d5.json"
          ],
          "nativeSessions": [
            "01a12315-8b95-7243-8949-1b20acf248cd"
          ],
          "originalCandidateCount": 3,
          "lineageCount": 8,
          "unofferedToolUses": [],
          "scopedLocationsMissing": true,
          "outcomeJoined": false
        }
      }
    },
    {
      "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
      "request_id": "35013188",
      "ledgerStatus": "ok",
      "candidates": 0,
      "exactArgumentMatches": 0,
      "pairs": [],
      "rejected": [],
      "receiptState": "unresolved",
      "acceptedUnique": false,
      "reason": "no-accepted-complete-pair",
      "cold24Reassessment": {
        "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
        "request_id": "35013188",
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
      "cold25Assessment": {
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
      "cold26Assessment": {
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
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch2-424d5.json",
        "outcomeJoined": false
      },
      "cold27Assessment": {
        "request_id": "35013188",
        "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "acceptedPairCount": 0,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a12315-8b95-7243-8949-1b20acf248cd",
            "callPart": 110,
            "resultPart": 111,
            "callTimestamp": "2026-10-10T00:13:39.584+00:00",
            "responseTimestamp": "2026-10-10T00:13:42.889+00:00",
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
            "nativeSession": "01a12315-8b95-7243-8949-1b20acf248cd",
            "callPart": 113,
            "resultPart": 114,
            "callTimestamp": "2026-10-10T00:14:10.182+00:00",
            "responseTimestamp": "2026-10-10T00:14:13.573+00:00",
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
          },
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
        "outcomeJoined": false,
        "assessmentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold27-original45-lineage-augmentation-batch2-424d5.json",
        "sourceLocationAssessment": {
          "request_id": "35013188",
          "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
          "ledger": {
            "id": "35013188",
            "tool_name": "session:request-compaction",
            "coord_owner_id": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
            "invoked_at": "2026-10-10 00:14:13.317+00",
            "duration_ms": 679,
            "status": "ok",
            "args_json": {
              "focus": "Resume EI-25536986894028197 after await 259522. The last lock row showed system:git-sync held through 00:17:01.294Z; recheck immediately and use sanctioned ptool git-sync:run only if unheld. The expected scratch-gc.ts source SHA matches locally, runtimeContainment is true, onStaging=false; inspect fresh sync quarantine/headroom evidence before traces. Work-item and loop checkpoints include the timestamp retraction and the Bulk Inbox disposition.",
              "autoContinue": true
            }
          },
          "sourceRefs": [
            "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch2-424d5.json"
          ],
          "nativeSessions": [
            "01a12315-8b95-7243-8949-1b20acf248cd"
          ],
          "originalCandidateCount": 3,
          "lineageCount": 8,
          "unofferedToolUses": [],
          "scopedLocationsMissing": true,
          "outcomeJoined": false
        }
      }
    },
    {
      "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
      "request_id": "35013284",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a12315-8b95-7243-8949-1b20acf248cd",
          "callPart": 115,
          "resultPart": 116,
          "literalArgsEqual": true,
          "ledgerOwner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-10 00:14:26.04+00",
          "durationMs": 535,
          "derivedDispatchStart": "2026-10-10T00:14:25.505Z",
          "callTimestamp": "2026-10-10T00:14:24.785+00:00",
          "responseTimestamp": "2026-10-10T00:14:26.232+00:00",
          "callBeforeDispatchMs": 720,
          "responseAfterSettleMs": 192,
          "bounds": true,
          "noAmbiguity": true,
          "error": "no-leading-json-format-or-complete-json-stream",
          "state": "unclassified",
          "statusAgrees": false,
          "accepted": false,
          "sourceComplete": false
        }
      ],
      "rejected": [],
      "receiptState": "unresolved",
      "acceptedUnique": false,
      "reason": "no-accepted-complete-pair",
      "cold24Reassessment": {
        "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
        "request_id": "35013284",
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
      "cold25Assessment": {
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
      "cold26Assessment": {
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
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch2-424d5.json",
        "outcomeJoined": false
      },
      "cold27Assessment": {
        "request_id": "35013284",
        "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "acceptedPairCount": 0,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a12315-8b95-7243-8949-1b20acf248cd",
            "callPart": 110,
            "resultPart": 111,
            "callTimestamp": "2026-10-10T00:13:39.584+00:00",
            "responseTimestamp": "2026-10-10T00:13:42.889+00:00",
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
            "nativeSession": "01a12315-8b95-7243-8949-1b20acf248cd",
            "callPart": 113,
            "resultPart": 114,
            "callTimestamp": "2026-10-10T00:14:10.182+00:00",
            "responseTimestamp": "2026-10-10T00:14:13.573+00:00",
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
          },
          {
            "nativeSession": "01a12329-777a-7b80-8fc3-ab01535f10ae",
            "callPart": 4,
            "resultPart": 5,
            "callTimestamp": "2026-10-10T00:15:21.344+00:00",
            "responseTimestamp": "2026-10-10T00:15:21.408+00:00",
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
            "nativeSession": "01a12329-777a-7b80-8fc3-ab01535f10ae",
            "callPart": 6,
            "resultPart": 7,
            "callTimestamp": "2026-10-10T00:15:23.014+00:00",
            "responseTimestamp": "2026-10-10T00:15:25.156+00:00",
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
        "outcomeJoined": false,
        "assessmentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold27-original45-lineage-augmentation-batch2-424d5.json",
        "sourceLocationAssessment": {
          "request_id": "35013284",
          "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
          "ledger": {
            "id": "35013284",
            "tool_name": "session:request-compaction",
            "coord_owner_id": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
            "invoked_at": "2026-10-10 00:14:26.04+00",
            "duration_ms": 535,
            "status": "ok",
            "args_json": {
              "focus": "Continue EI-25536986894028197 on await 259522. The work-item checkpoint now anchors and retracts the false lock-read timestamp. Recheck the resource immediately; run sanctioned ptool git-sync:run only if unheld. Verify the accepted source SHA on staging and runtime containment before trace collection.",
              "autoContinue": true
            }
          },
          "sourceRefs": [
            "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch2-424d5.json"
          ],
          "nativeSessions": [
            "01a12315-8b95-7243-8949-1b20acf248cd",
            "01a12329-777a-7b80-8fc3-ab01535f10ae"
          ],
          "originalCandidateCount": 5,
          "lineageCount": 13,
          "unofferedToolUses": [
            {
              "session_id": "01a12329-777a-7b80-8fc3-ab01535f10ae",
              "part_idx": 8,
              "tool_name": "exec",
              "chars": 91,
              "clipped": false
            }
          ],
          "scopedLocationsMissing": true,
          "outcomeJoined": false
        }
      }
    },
    {
      "owner": "su-960a52e7-9b11-42ac-8fe9-7e5e7e0da441",
      "request_id": "35014709",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a12315-a40e-7280-a1e8-9f2ac48b1d4e",
          "callPart": 170,
          "resultPart": 171,
          "literalArgsEqual": true,
          "ledgerOwner": "su-960a52e7-9b11-42ac-8fe9-7e5e7e0da441",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-10 00:17:31.86+00",
          "durationMs": 765,
          "derivedDispatchStart": "2026-10-10T00:17:31.095Z",
          "callTimestamp": "2026-10-10T00:17:28.795+00:00",
          "responseTimestamp": "2026-10-10T00:17:32.072+00:00",
          "callBeforeDispatchMs": 2300,
          "responseAfterSettleMs": 212,
          "bounds": true,
          "noAmbiguity": true,
          "error": "no-leading-json-format-or-complete-json-stream",
          "state": "unclassified",
          "statusAgrees": false,
          "accepted": false,
          "sourceComplete": false
        }
      ],
      "rejected": [],
      "receiptState": "unresolved",
      "acceptedUnique": false,
      "reason": "no-accepted-complete-pair",
      "cold24Reassessment": {
        "owner": "su-960a52e7-9b11-42ac-8fe9-7e5e7e0da441",
        "request_id": "35014709",
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
      "cold25Assessment": {
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
      "cold26Assessment": {
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
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch2-424d5.json",
        "outcomeJoined": false
      },
      "cold27Assessment": {
        "request_id": "35014709",
        "owner": "su-960a52e7-9b11-42ac-8fe9-7e5e7e0da441",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "acceptedPairCount": 0,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a12315-a40e-7280-a1e8-9f2ac48b1d4e",
            "callPart": 166,
            "resultPart": 167,
            "callTimestamp": "2026-10-10T00:16:54.071+00:00",
            "responseTimestamp": "2026-10-10T00:17:03.094+00:00",
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
            "nativeSession": "01a12315-a40e-7280-a1e8-9f2ac48b1d4e",
            "callPart": 168,
            "resultPart": 169,
            "callTimestamp": "2026-10-10T00:17:11.97+00:00",
            "responseTimestamp": "2026-10-10T00:17:13.134+00:00",
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
          },
          {
            "nativeSession": "01a1232c-37f8-7e61-a664-1dbf34681ab9",
            "callPart": 4,
            "resultPart": 5,
            "callTimestamp": "2026-10-10T00:18:10.546+00:00",
            "responseTimestamp": "2026-10-10T00:18:10.648+00:00",
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
            "nativeSession": "01a1232c-37f8-7e61-a664-1dbf34681ab9",
            "callPart": 6,
            "resultPart": 7,
            "callTimestamp": "2026-10-10T00:18:13.096+00:00",
            "responseTimestamp": "2026-10-10T00:18:13.248+00:00",
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
            "nativeSession": "01a1232c-37f8-7e61-a664-1dbf34681ab9",
            "callPart": 8,
            "resultPart": 9,
            "callTimestamp": "2026-10-10T00:18:18.024+00:00",
            "responseTimestamp": "2026-10-10T00:18:20.943+00:00",
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
            "nativeSession": "01a1232c-37f8-7e61-a664-1dbf34681ab9",
            "callPart": 10,
            "resultPart": 11,
            "callTimestamp": "2026-10-10T00:18:23.165+00:00",
            "responseTimestamp": "2026-10-10T00:18:23.602+00:00",
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
        "outcomeJoined": false,
        "assessmentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold27-original45-lineage-augmentation-batch2-424d5.json",
        "sourceLocationAssessment": {
          "request_id": "35014709",
          "owner": "su-960a52e7-9b11-42ac-8fe9-7e5e7e0da441",
          "ledger": {
            "id": "35014709",
            "tool_name": "session:request-compaction",
            "coord_owner_id": "su-960a52e7-9b11-42ac-8fe9-7e5e7e0da441",
            "invoked_at": "2026-10-10 00:17:31.86+00",
            "duration_ms": 765,
            "status": "ok",
            "args_json": {
              "focus": "Verify identity with coord:whoami first. EI-25535047319090973 is closed. EI-25547073030018889 is held/checkpointed: GNU df rejects -i with --output; live /tmp and /mnt/data share /dev/nvme1n1 XFS, 100%, 595,738,624 bytes available. Next check events:status for coord:inbox-wake:su-960a52e7-9b11-42ac-8fe9-7e5e7e0da441, inspect capability:bash semantics and existing disk/git-sync work, then decide whether to close the caller-error report or file a separate owned disk item. Original claim-spec loop restored at 60s cold; rewake verified.",
              "autoContinue": true
            }
          },
          "sourceRefs": [
            "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch2-424d5.json"
          ],
          "nativeSessions": [
            "01a12315-a40e-7280-a1e8-9f2ac48b1d4e",
            "01a1232c-37f8-7e61-a664-1dbf34681ab9"
          ],
          "originalCandidateCount": 7,
          "lineageCount": 16,
          "unofferedToolUses": [],
          "scopedLocationsMissing": true,
          "outcomeJoined": false
        }
      }
    },
    {
      "owner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
      "request_id": "35015047",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a1231e-4587-78c2-aa03-27c4229be312",
          "callPart": 94,
          "resultPart": 95,
          "literalArgsEqual": true,
          "ledgerOwner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-10 00:18:05.707+00",
          "durationMs": 677,
          "derivedDispatchStart": "2026-10-10T00:18:05.030Z",
          "callTimestamp": "2026-10-10T00:18:03.917+00:00",
          "responseTimestamp": "2026-10-10T00:18:06.073+00:00",
          "callBeforeDispatchMs": 1113,
          "responseAfterSettleMs": 366,
          "bounds": true,
          "noAmbiguity": true,
          "error": "no-compaction-body",
          "state": "unclassified",
          "statusAgrees": false,
          "accepted": false,
          "sourceComplete": false
        }
      ],
      "rejected": [],
      "receiptState": "unresolved",
      "acceptedUnique": false,
      "reason": "no-accepted-complete-pair",
      "cold24Reassessment": {
        "owner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
        "request_id": "35015047",
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
      "cold25Assessment": {
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
      "cold26Assessment": {
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
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch2-424d5.json",
        "outcomeJoined": false
      },
      "cold27Assessment": {
        "request_id": "35015047",
        "owner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "acceptedPairCount": 0,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a1231e-4587-78c2-aa03-27c4229be312",
            "callPart": 91,
            "resultPart": 92,
            "callTimestamp": "2026-10-10T00:17:36.83+00:00",
            "responseTimestamp": "2026-10-10T00:17:39.127+00:00",
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
          },
          {
            "nativeSession": "01a1232c-bbfd-7201-ae9d-dabbbdc1be14",
            "callPart": 4,
            "resultPart": 5,
            "callTimestamp": "2026-10-10T00:18:52.219+00:00",
            "responseTimestamp": "2026-10-10T00:18:52.294+00:00",
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
            "nativeSession": "01a1232c-bbfd-7201-ae9d-dabbbdc1be14",
            "callPart": 6,
            "resultPart": 7,
            "callTimestamp": "2026-10-10T00:18:55.061+00:00",
            "responseTimestamp": "2026-10-10T00:18:55.142+00:00",
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
            "nativeSession": "01a1232c-bbfd-7201-ae9d-dabbbdc1be14",
            "callPart": 8,
            "resultPart": 9,
            "callTimestamp": "2026-10-10T00:18:57.289+00:00",
            "responseTimestamp": "2026-10-10T00:19:00.367+00:00",
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
        "outcomeJoined": false,
        "assessmentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold27-original45-lineage-augmentation-batch2-424d5.json",
        "sourceLocationAssessment": {
          "request_id": "35015047",
          "owner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
          "ledger": {
            "id": "35015047",
            "tool_name": "session:request-compaction",
            "coord_owner_id": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
            "invoked_at": "2026-10-10 00:18:05.707+00",
            "duration_ms": 677,
            "status": "ok",
            "args_json": {
              "focus": "Continue fleet claim-spec lane after completing EI-25541385148400614. The item is done with completionAuthority proposed pending automatic git-sync content-identity settlement for two test files; do not re-complete or monitor absent an explicit superseded-before-commit message. Next action is scheduler:get_next for fleet-launch-nonp2p-bug-drain-luna-max-0930-kinds in papercusp.",
              "autoContinue": true
            }
          },
          "sourceRefs": [
            "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch2-424d5.json"
          ],
          "nativeSessions": [
            "01a1231e-4587-78c2-aa03-27c4229be312",
            "01a1232c-bbfd-7201-ae9d-dabbbdc1be14"
          ],
          "originalCandidateCount": 5,
          "lineageCount": 13,
          "unofferedToolUses": [
            {
              "session_id": "01a1232c-bbfd-7201-ae9d-dabbbdc1be14",
              "part_idx": 10,
              "tool_name": "exec",
              "chars": 67,
              "clipped": false
            }
          ],
          "scopedLocationsMissing": true,
          "outcomeJoined": false
        }
      }
    },
    {
      "owner": "su-82c46308-5eb9-4237-9d2d-950d322576c4",
      "request_id": "35018210",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 0,
      "pairs": [],
      "rejected": [],
      "receiptState": "unresolved",
      "acceptedUnique": false,
      "reason": "no-accepted-complete-pair",
      "cold24Reassessment": {
        "owner": "su-82c46308-5eb9-4237-9d2d-950d322576c4",
        "request_id": "35018210",
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
      "cold25Assessment": {
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
      "cold26Assessment": {
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
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch2-424d5.json",
        "outcomeJoined": false
      },
      "cold27Assessment": {
        "request_id": "35018210",
        "owner": "su-82c46308-5eb9-4237-9d2d-950d322576c4",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "acceptedPairCount": 0,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a1231e-b6d5-7ee0-8ce8-73fb43067a42",
            "callPart": 138,
            "resultPart": 139,
            "callTimestamp": "2026-10-10T00:24:07.349+00:00",
            "responseTimestamp": "2026-10-10T00:24:12.098+00:00",
            "mechanisms": [],
            "conditionalAlternatives": false,
            "chain": null,
            "literalArgsEqual": false,
            "ownerEqual": true,
            "bounds": false,
            "sourceComplete": false,
            "parseErrors": 4,
            "receiptState": "unclassified",
            "statusAgrees": false,
            "completeOriginalPair": false
          },
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
          },
          {
            "nativeSession": "01a12332-bcc7-7303-ae0d-4c748ccc0059",
            "callPart": 4,
            "resultPart": 5,
            "callTimestamp": "2026-10-10T00:25:28.747+00:00",
            "responseTimestamp": "2026-10-10T00:25:28.836+00:00",
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
            "nativeSession": "01a12332-bcc7-7303-ae0d-4c748ccc0059",
            "callPart": 6,
            "resultPart": 7,
            "callTimestamp": "2026-10-10T00:25:31.218+00:00",
            "responseTimestamp": "2026-10-10T00:25:31.276+00:00",
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
            "nativeSession": "01a12332-bcc7-7303-ae0d-4c748ccc0059",
            "callPart": 8,
            "resultPart": 9,
            "callTimestamp": "2026-10-10T00:25:33.542+00:00",
            "responseTimestamp": "2026-10-10T00:25:36.062+00:00",
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
          }
        ],
        "outcomeJoined": false,
        "assessmentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold27-original45-lineage-augmentation-batch2-424d5.json",
        "sourceLocationAssessment": {
          "request_id": "35018210",
          "owner": "su-82c46308-5eb9-4237-9d2d-950d322576c4",
          "ledger": {
            "id": "35018210",
            "tool_name": "session:request-compaction",
            "coord_owner_id": "su-82c46308-5eb9-4237-9d2d-950d322576c4",
            "invoked_at": "2026-10-10 00:24:41.364+00",
            "duration_ms": 590,
            "status": "ok",
            "args_json": {
              "focus": "Continue the two held non-P2P bug-drain items within the existing rev12/maxConcurrentClaims=2 fleet spec. Reconcile live loop status, route/ENOSPC evidence, and leader cap disposition; do not pull more work.",
              "autoContinue": true
            }
          },
          "sourceRefs": [
            "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch2-424d5.json"
          ],
          "nativeSessions": [
            "01a1231e-b6d5-7ee0-8ce8-73fb43067a42",
            "01a12332-bcc7-7303-ae0d-4c748ccc0059"
          ],
          "originalCandidateCount": 5,
          "lineageCount": 12,
          "unofferedToolUses": [
            {
              "session_id": "01a12332-bcc7-7303-ae0d-4c748ccc0059",
              "part_idx": 10,
              "tool_name": "exec",
              "chars": 109,
              "clipped": false
            }
          ],
          "scopedLocationsMissing": true,
          "outcomeJoined": false
        }
      }
    },
    {
      "request_id": "35020841",
      "owner": "su-449b83a8-a709-43af-9681-768dc6ac744a",
      "acceptedUnique": true,
      "completeOriginalPair": true,
      "receiptState": "queued",
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
          "receiptState": "queued",
          "statusAgrees": true,
          "format": "toon",
          "requested": true,
          "respawn": "queued",
          "completeOriginalPair": true
        }
      ],
      "acceptedPairCount": 1,
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch2-424d5.json",
      "outcomeJoined": false,
      "assessmentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold26-native-assessment-original49-424d5.json",
      "instrumentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold26-native-analysis-instrument-424d5.json"
    },
    {
      "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
      "request_id": "35022684",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 0,
      "pairs": [],
      "rejected": [
        {
          "session": "01a12329-777a-7b80-8fc3-ab01535f10ae",
          "part": 104,
          "reason": "Error: nonliteral argument:Identifier"
        }
      ],
      "receiptState": "unresolved",
      "acceptedUnique": false,
      "reason": "no-accepted-complete-pair",
      "cold24Reassessment": {
        "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
        "request_id": "35022684",
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
      "cold25Assessment": {
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
      "cold26Assessment": {
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
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch2-424d5.json",
        "outcomeJoined": false
      },
      "cold27Assessment": {
        "request_id": "35022684",
        "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "acceptedPairCount": 0,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a12329-777a-7b80-8fc3-ab01535f10ae",
            "callPart": 101,
            "resultPart": 102,
            "callTimestamp": "2026-10-10T00:33:12.304+00:00",
            "responseTimestamp": "2026-10-10T00:33:14.639+00:00",
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
          },
          {
            "nativeSession": "01a1233a-d987-7c81-ab19-ebb8b26a4768",
            "callPart": 4,
            "resultPart": 5,
            "callTimestamp": "2026-10-10T00:34:08.056+00:00",
            "responseTimestamp": "2026-10-10T00:34:08.116+00:00",
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
            "nativeSession": "01a1233a-d987-7c81-ab19-ebb8b26a4768",
            "callPart": 6,
            "resultPart": 7,
            "callTimestamp": "2026-10-10T00:34:12.153+00:00",
            "responseTimestamp": "2026-10-10T00:34:12.289+00:00",
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
            "nativeSession": "01a1233a-d987-7c81-ab19-ebb8b26a4768",
            "callPart": 8,
            "resultPart": 9,
            "callTimestamp": "2026-10-10T00:34:19.296+00:00",
            "responseTimestamp": "2026-10-10T00:34:19.355+00:00",
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
            "nativeSession": "01a1233a-d987-7c81-ab19-ebb8b26a4768",
            "callPart": 10,
            "resultPart": 11,
            "callTimestamp": "2026-10-10T00:34:22.665+00:00",
            "responseTimestamp": "2026-10-10T00:34:22.733+00:00",
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
          }
        ],
        "outcomeJoined": false,
        "assessmentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold27-original45-lineage-augmentation-batch3-424d5.json",
        "sourceLocationAssessment": {
          "request_id": "35022684",
          "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
          "ledger": {
            "id": "35022684",
            "tool_name": "session:request-compaction",
            "coord_owner_id": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
            "invoked_at": "2026-10-10 00:33:32.347+00",
            "duration_ms": 1140,
            "status": "ok",
            "args_json": {
              "focus": "Continue EI-25536986894028197 after the registered await on work-item:done:WI-10007825. Reconcile the fresh ENOSPC evidence and peer response already recorded in the item/loop checkpoints; do not retry ptool or inspect/delete shared artifacts until the owned diagnosis resolves. Recheck the git-sync resource and source/runtime state before any sync or trace logs.",
              "autoContinue": true
            }
          },
          "sourceRefs": [
            "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch2-424d5.json"
          ],
          "nativeSessions": [
            "01a12329-777a-7b80-8fc3-ab01535f10ae",
            "01a1233a-d987-7c81-ab19-ebb8b26a4768"
          ],
          "originalCandidateCount": 6,
          "lineageCount": 15,
          "unofferedToolUses": [
            {
              "session_id": "01a1233a-d987-7c81-ab19-ebb8b26a4768",
              "part_idx": 12,
              "tool_name": "exec",
              "chars": 561,
              "clipped": false
            }
          ],
          "scopedLocationsMissing": true,
          "outcomeJoined": false
        }
      }
    },
    {
      "owner": "su-960a52e7-9b11-42ac-8fe9-7e5e7e0da441",
      "request_id": "35023582",
      "ledgerStatus": "ok",
      "candidates": 0,
      "exactArgumentMatches": 0,
      "pairs": [],
      "rejected": [],
      "receiptState": "unresolved",
      "acceptedUnique": false,
      "reason": "no-accepted-complete-pair",
      "cold24Reassessment": {
        "owner": "su-960a52e7-9b11-42ac-8fe9-7e5e7e0da441",
        "request_id": "35023582",
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
      "cold25Assessment": {
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
      "cold26Assessment": {
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
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch2-424d5.json",
        "outcomeJoined": false
      },
      "cold27Assessment": {
        "request_id": "35023582",
        "owner": "su-960a52e7-9b11-42ac-8fe9-7e5e7e0da441",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "acceptedPairCount": 0,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a1232c-37f8-7e61-a664-1dbf34681ab9",
            "callPart": 104,
            "resultPart": 105,
            "callTimestamp": "2026-10-10T00:34:13.496+00:00",
            "responseTimestamp": "2026-10-10T00:34:14.946+00:00",
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
            "nativeSession": "01a1232c-37f8-7e61-a664-1dbf34681ab9",
            "callPart": 106,
            "resultPart": 107,
            "callTimestamp": "2026-10-10T00:34:26.327+00:00",
            "responseTimestamp": "2026-10-10T00:34:27.729+00:00",
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
        "outcomeJoined": false,
        "assessmentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold27-original45-lineage-augmentation-batch3-424d5.json",
        "sourceLocationAssessment": {
          "request_id": "35023582",
          "owner": "su-960a52e7-9b11-42ac-8fe9-7e5e7e0da441",
          "ledger": {
            "id": "35023582",
            "tool_name": "session:request-compaction",
            "coord_owner_id": "su-960a52e7-9b11-42ac-8fe9-7e5e7e0da441",
            "invoked_at": "2026-10-10 00:35:12.21+00",
            "duration_ms": 3045,
            "status": "ok",
            "args_json": {
              "focus": "Fresh successor for su-960a52e7-9b11-42ac-8fe9-7e5e7e0da441 in nonp2p-bug-drain-luna-max-0930. Work-item EI-25547073030018889 is terminal done as caller-side GNU df syntax; fresh 71,004,160-byte shared-device measurement was sent to the owner of EI-25526420868277353. Held EI-25392760794406844 remains open and assigned to self; its updated checkpoint hash is 92cc9140ec49 and its check ledger was updated. The exact 2026-10-08 06:39Z refusal branch is still unknown; do not close as duplicate based only on the shared error code. The peer consult had no responder and was captured as EI-25550214499894165. Current claim spec revision 12 admits only non-p2p bugs; do not act on EI-25535047319090973. The 60-second cold loop is active but not a guaranteed wake: loop:status said rewakeGuaranteed=false / last-fire-no-loop-turn, and inbox delivery 570085 was delivered as suppressed-redundant with turn_invoked=false. Current item and loop checkpoints are flushed. Inspect current native session state, repair the existing loop delivery-to-turn path, confirm a real loop-origin turn, then continue the held item and scheduler-admitted lane.",
              "autoContinue": true
            }
          },
          "sourceRefs": [
            "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch2-424d5.json"
          ],
          "nativeSessions": [
            "01a1232c-37f8-7e61-a664-1dbf34681ab9"
          ],
          "originalCandidateCount": 3,
          "lineageCount": 7,
          "unofferedToolUses": [],
          "scopedLocationsMissing": true,
          "outcomeJoined": false
        }
      }
    },
    {
      "owner": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
      "request_id": "35030923",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 0,
      "pairs": [],
      "rejected": [],
      "receiptState": "unresolved",
      "acceptedUnique": false,
      "reason": "no-accepted-complete-pair",
      "cold24Reassessment": {
        "owner": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
        "request_id": "35030923",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [],
        "acceptedPairCount": 0,
        "outcomeJoined": false
      },
      "cold25Assessment": {
        "request_id": "35030923",
        "owner": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [],
        "acceptedPairCount": 0,
        "outcomeJoined": false
      },
      "cold26Assessment": {
        "request_id": "35030923",
        "owner": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [],
        "acceptedPairCount": 0,
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch2-424d5.json",
        "outcomeJoined": false
      },
      "cold27Assessment": {
        "request_id": "35030923",
        "owner": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "acceptedPairCount": 0,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a12337-f502-7103-9a8a-d2d14c76be56",
            "callPart": 134,
            "resultPart": 135,
            "callTimestamp": "2026-10-10T00:48:40.996+00:00",
            "responseTimestamp": "2026-10-10T00:48:44.01+00:00",
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
            "nativeSession": "01a12337-f502-7103-9a8a-d2d14c76be56",
            "callPart": 136,
            "resultPart": 137,
            "callTimestamp": "2026-10-10T00:48:48.345+00:00",
            "responseTimestamp": "2026-10-10T00:48:48.899+00:00",
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
            "nativeSession": "01a12337-f502-7103-9a8a-d2d14c76be56",
            "callPart": 138,
            "resultPart": 139,
            "callTimestamp": "2026-10-10T00:49:06.432+00:00",
            "responseTimestamp": "2026-10-10T00:49:07.131+00:00",
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
            "nativeSession": "01a12337-f502-7103-9a8a-d2d14c76be56",
            "callPart": 141,
            "resultPart": 142,
            "callTimestamp": "2026-10-10T00:49:25.882+00:00",
            "responseTimestamp": "2026-10-10T00:49:28.017+00:00",
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
          },
          {
            "nativeSession": "01a12349-7117-7211-955a-cc49fb6d9292",
            "callPart": 4,
            "resultPart": 5,
            "callTimestamp": "2026-10-10T00:50:11.917+00:00",
            "responseTimestamp": "2026-10-10T00:50:11.985+00:00",
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
            "nativeSession": "01a12349-7117-7211-955a-cc49fb6d9292",
            "callPart": 6,
            "resultPart": 7,
            "callTimestamp": "2026-10-10T00:50:14.967+00:00",
            "responseTimestamp": "2026-10-10T00:50:17.345+00:00",
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
        "outcomeJoined": false,
        "assessmentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold27-original45-lineage-augmentation-batch3-424d5.json",
        "sourceLocationAssessment": {
          "request_id": "35030923",
          "owner": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
          "ledger": {
            "id": "35030923",
            "tool_name": "session:request-compaction",
            "coord_owner_id": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
            "invoked_at": "2026-10-10 00:49:27.851+00",
            "duration_ms": 725,
            "status": "ok",
            "args_json": {
              "focus": "Resume EI-25532836303285911 from the latest work-item and loop checkpoints. Identity is su-77348e3d-80ac-42d8-b4e7-bdce9684a72a; do not replay the historical targets WI-5984 or EI-25448610681866146. One bounded self-owned staging probe succeeded: invocation 35027315, duration 623ms, store transaction 552ms, checkpoint hash 6b1ebf116dc6; current-turn sentinel resolution remains unmeasured. Continue by instrumenting or measuring the pre-write provenance stages on safe self-owned data, and preserve that historical root cause as unknown until evidence distinguishes it.",
              "autoContinue": true
            }
          },
          "sourceRefs": [
            "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch2-424d5.json"
          ],
          "nativeSessions": [
            "01a12337-f502-7103-9a8a-d2d14c76be56",
            "01a12349-7117-7211-955a-cc49fb6d9292"
          ],
          "originalCandidateCount": 6,
          "lineageCount": 15,
          "unofferedToolUses": [
            {
              "session_id": "01a12349-7117-7211-955a-cc49fb6d9292",
              "part_idx": 8,
              "tool_name": "exec",
              "chars": 266,
              "clipped": false
            }
          ],
          "scopedLocationsMissing": true,
          "outcomeJoined": false
        }
      }
    },
    {
      "owner": "su-ab8cc07f-e903-4467-ac45-a32149258170",
      "request_id": "35031313",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a12339-7862-78e3-b4af-30c8e8bbe6f7",
          "callPart": 156,
          "resultPart": 157,
          "literalArgsEqual": true,
          "ledgerOwner": "su-ab8cc07f-e903-4467-ac45-a32149258170",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-10 00:50:07.858+00",
          "durationMs": 2380,
          "derivedDispatchStart": "2026-10-10T00:50:05.478Z",
          "callTimestamp": "2026-10-10T00:50:05.216+00:00",
          "responseTimestamp": "2026-10-10T00:50:08.436+00:00",
          "callBeforeDispatchMs": 262,
          "responseAfterSettleMs": 578,
          "bounds": true,
          "noAmbiguity": true,
          "format": "toon",
          "textBlocks": null,
          "body": {
            "ok": true,
            "requested": true,
            "respawn": "queued",
            "budgetChars": 331360,
            "firstPromptSource": "continuation-note",
            "staleCheckpoints": [],
            "openOwnerQuestion": false,
            "priorRespawn": {
              "outcome": "delivered",
              "ts": "2026-10-10T00:32:37.666Z",
              "ageMs": 1049237,
              "capMs": null
            },
            "note": "Carry-respawn QUEUED — not performed yet. The host cuts this process only once your pty goes QUIET at a clean boundary, then respawns your successor on the deterministic carry document. It re-polls for a few minutes and can terminally DROP the carry — an interactive back-and-forth, or steady output, can supersede it indefinitely. So: wrap up and go quiet now, but FLUSH durable state first (work_items:checkpoint / loop:checkpoint / facts:assert) rather than relying on the cut. If you are still here on your next turn, it did not happen — re-request at the next clean stopping point instead of waiting."
          },
          "state": "queued",
          "statusAgrees": true,
          "accepted": true,
          "sourceComplete": true
        }
      ],
      "rejected": [],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null
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
      "outcomeJoined": false,
      "assessmentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch2-424d5.json",
      "instrumentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold25-native-analysis-instrument-424d5.json"
    },
    {
      "owner": "su-82c46308-5eb9-4237-9d2d-950d322576c4",
      "request_id": "35038308",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a12344-1bcc-7313-bd5f-46510e73c99c",
          "callPart": 127,
          "resultPart": 128,
          "literalArgsEqual": true,
          "ledgerOwner": "su-82c46308-5eb9-4237-9d2d-950d322576c4",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-10 01:03:17.598+00",
          "durationMs": 819,
          "derivedDispatchStart": "2026-10-10T01:03:16.779Z",
          "callTimestamp": "2026-10-10T01:03:16.53+00:00",
          "responseTimestamp": "2026-10-10T01:03:18.102+00:00",
          "callBeforeDispatchMs": 249,
          "responseAfterSettleMs": 504,
          "bounds": true,
          "noAmbiguity": true,
          "format": "toon",
          "textBlocks": null,
          "body": {
            "ok": true,
            "requested": true,
            "respawn": "queued",
            "budgetChars": 331360,
            "firstPromptSource": "continuation-note",
            "staleCheckpoints": [],
            "openOwnerQuestion": false,
            "priorRespawn": {
              "outcome": "delivered",
              "ts": "2026-10-10T00:44:15.644Z",
              "ageMs": 1141926,
              "capMs": null
            },
            "note": "Carry-respawn QUEUED — not performed yet. The host cuts this process only once your pty goes QUIET at a clean boundary, then respawns your successor on the deterministic carry document. It re-polls for a few minutes and can terminally DROP the carry — an interactive back-and-forth, or steady output, can supersede it indefinitely. So: wrap up and go quiet now, but FLUSH durable state first (work_items:checkpoint / loop:checkpoint / facts:assert) rather than relying on the cut. If you are still here on your next turn, it did not happen — re-request at the next clean stopping point instead of waiting."
          },
          "state": "queued",
          "statusAgrees": true,
          "accepted": true,
          "sourceComplete": true
        }
      ],
      "rejected": [],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null
    },
    {
      "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
      "request_id": "35038763",
      "ledgerStatus": "ok",
      "candidates": 0,
      "exactArgumentMatches": 0,
      "pairs": [],
      "rejected": [],
      "receiptState": "unresolved",
      "acceptedUnique": false,
      "reason": "no-accepted-complete-pair",
      "cold24Reassessment": {
        "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
        "request_id": "35038763",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [],
        "acceptedPairCount": 0,
        "outcomeJoined": false
      },
      "cold25Assessment": {
        "request_id": "35038763",
        "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [],
        "acceptedPairCount": 0,
        "outcomeJoined": false
      },
      "cold26Assessment": {
        "request_id": "35038763",
        "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [],
        "acceptedPairCount": 0,
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch2-424d5.json",
        "outcomeJoined": false
      },
      "cold27Assessment": {
        "request_id": "35038763",
        "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "acceptedPairCount": 0,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a1233a-d987-7c81-ab19-ebb8b26a4768",
            "callPart": 97,
            "resultPart": 98,
            "callTimestamp": "2026-10-10T01:03:48.578+00:00",
            "responseTimestamp": "2026-10-10T01:04:23.732+00:00",
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
          },
          {
            "nativeSession": "01a12357-33fa-76b1-9add-840d4be15ec1",
            "callPart": 4,
            "resultPart": 5,
            "callTimestamp": "2026-10-10T01:04:50.594+00:00",
            "responseTimestamp": "2026-10-10T01:04:50.72+00:00",
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
            "nativeSession": "01a12357-33fa-76b1-9add-840d4be15ec1",
            "callPart": 6,
            "resultPart": 7,
            "callTimestamp": "2026-10-10T01:04:57.559+00:00",
            "responseTimestamp": "2026-10-10T01:04:57.589+00:00",
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
            "nativeSession": "01a12357-33fa-76b1-9add-840d4be15ec1",
            "callPart": 8,
            "resultPart": 9,
            "callTimestamp": "2026-10-10T01:05:01.239+00:00",
            "responseTimestamp": "2026-10-10T01:05:04.145+00:00",
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
            "nativeSession": "01a12357-33fa-76b1-9add-840d4be15ec1",
            "callPart": 10,
            "resultPart": 11,
            "callTimestamp": "2026-10-10T01:05:06.397+00:00",
            "responseTimestamp": "2026-10-10T01:05:08.501+00:00",
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
            "nativeSession": "01a12357-33fa-76b1-9add-840d4be15ec1",
            "callPart": 12,
            "resultPart": 13,
            "callTimestamp": "2026-10-10T01:05:12.761+00:00",
            "responseTimestamp": "2026-10-10T01:05:13.677+00:00",
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
            "nativeSession": "01a12357-33fa-76b1-9add-840d4be15ec1",
            "callPart": 14,
            "resultPart": 15,
            "callTimestamp": "2026-10-10T01:05:18.491+00:00",
            "responseTimestamp": "2026-10-10T01:05:29.892+00:00",
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
          }
        ],
        "outcomeJoined": false,
        "assessmentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold27-original45-lineage-augmentation-batch3-424d5.json",
        "sourceLocationAssessment": {
          "request_id": "35038763",
          "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
          "ledger": {
            "id": "35038763",
            "tool_name": "session:request-compaction",
            "coord_owner_id": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
            "invoked_at": "2026-10-10 01:04:22.9+00",
            "duration_ms": 2421,
            "status": "ok",
            "args_json": {
              "focus": "Resume EI-25536986894028197 after timeout await_id 259730. Current session 01a1233a is verified; fresh work-item:done:WI-10007825 await is 259792 through 2026-10-10T01:14:07.930Z. Check the assigned owner's status/handoff response and WI state before any retry; preserve the distinct result-door, ptool ENOSPC, and git-sync headroom findings.",
              "autoContinue": true
            }
          },
          "sourceRefs": [
            "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch2-424d5.json"
          ],
          "nativeSessions": [
            "01a1233a-d987-7c81-ab19-ebb8b26a4768",
            "01a12357-33fa-76b1-9add-840d4be15ec1"
          ],
          "originalCandidateCount": 7,
          "lineageCount": 16,
          "unofferedToolUses": [],
          "scopedLocationsMissing": true,
          "outcomeJoined": false
        }
      }
    },
    {
      "owner": "su-449b83a8-a709-43af-9681-768dc6ac744a",
      "request_id": "35039357",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 0,
      "pairs": [],
      "rejected": [
        {
          "session": "01a12348-953f-7483-9589-e1a23948d6f5",
          "part": 138,
          "reason": "argument-mismatch"
        }
      ],
      "receiptState": "unresolved",
      "acceptedUnique": false,
      "reason": "no-accepted-complete-pair",
      "cold24Reassessment": {
        "owner": "su-449b83a8-a709-43af-9681-768dc6ac744a",
        "request_id": "35039357",
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
      "cold25Assessment": {
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
      "cold26Assessment": {
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
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch2-424d5.json",
        "outcomeJoined": false
      },
      "cold27Assessment": {
        "request_id": "35039357",
        "owner": "su-449b83a8-a709-43af-9681-768dc6ac744a",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "acceptedPairCount": 0,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a12348-953f-7483-9589-e1a23948d6f5",
            "callPart": 133,
            "resultPart": 134,
            "callTimestamp": "2026-10-10T01:04:42.825+00:00",
            "responseTimestamp": "2026-10-10T01:04:51.41+00:00",
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
            "nativeSession": "01a12348-953f-7483-9589-e1a23948d6f5",
            "callPart": 136,
            "resultPart": 137,
            "callTimestamp": "2026-10-10T01:05:14.319+00:00",
            "responseTimestamp": "2026-10-10T01:05:14.751+00:00",
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
          },
          {
            "nativeSession": "01a12358-40b3-7071-afa8-73e105e0851b",
            "callPart": 4,
            "resultPart": 5,
            "callTimestamp": "2026-10-10T01:06:00.378+00:00",
            "responseTimestamp": "2026-10-10T01:06:00.49+00:00",
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
            "nativeSession": "01a12358-40b3-7071-afa8-73e105e0851b",
            "callPart": 6,
            "resultPart": 7,
            "callTimestamp": "2026-10-10T01:06:03.377+00:00",
            "responseTimestamp": "2026-10-10T01:06:03.47+00:00",
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
            "nativeSession": "01a12358-40b3-7071-afa8-73e105e0851b",
            "callPart": 8,
            "resultPart": 9,
            "callTimestamp": "2026-10-10T01:06:06.145+00:00",
            "responseTimestamp": "2026-10-10T01:06:06.232+00:00",
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
            "nativeSession": "01a12358-40b3-7071-afa8-73e105e0851b",
            "callPart": 10,
            "resultPart": 11,
            "callTimestamp": "2026-10-10T01:06:09.699+00:00",
            "responseTimestamp": "2026-10-10T01:06:16.074+00:00",
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
            "nativeSession": "01a12358-40b3-7071-afa8-73e105e0851b",
            "callPart": 12,
            "resultPart": 13,
            "callTimestamp": "2026-10-10T01:06:19.322+00:00",
            "responseTimestamp": "2026-10-10T01:06:19.418+00:00",
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
            "nativeSession": "01a12358-40b3-7071-afa8-73e105e0851b",
            "callPart": 14,
            "resultPart": 15,
            "callTimestamp": "2026-10-10T01:06:21.201+00:00",
            "responseTimestamp": "2026-10-10T01:06:21.765+00:00",
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
        "outcomeJoined": false,
        "assessmentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold27-original45-lineage-augmentation-batch3-424d5.json",
        "sourceLocationAssessment": {
          "request_id": "35039357",
          "owner": "su-449b83a8-a709-43af-9681-768dc6ac744a",
          "ledger": {
            "id": "35039357",
            "tool_name": "session:request-compaction",
            "coord_owner_id": "su-449b83a8-a709-43af-9681-768dc6ac744a",
            "invoked_at": "2026-10-10 01:05:29.039+00",
            "duration_ms": 922,
            "status": "ok",
            "args_json": {
              "focus": "Resume EI-25544304590998746 from the work-item and loop checkpoints. Complete D-012 settlement: read exact plans:set-specs and bind-spec-evidence schemas, author one active ad-hoc clause for planItemId P-25544304590998746, bind local Vitest run 20966034, then run git-sync:run and re-close with top-level specAdequacy after committed blob identities match. The ptool source/test fix is already implemented and verified; do not repeat the same-key locks:acquire replay. Original journal traces and test evidence are listed in the checkpoints.",
              "autoContinue": true
            }
          },
          "sourceRefs": [
            "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch2-424d5.json"
          ],
          "nativeSessions": [
            "01a12348-953f-7483-9589-e1a23948d6f5",
            "01a12358-40b3-7071-afa8-73e105e0851b"
          ],
          "originalCandidateCount": 9,
          "lineageCount": 21,
          "unofferedToolUses": [
            {
              "session_id": "01a12358-40b3-7071-afa8-73e105e0851b",
              "part_idx": 16,
              "tool_name": "exec",
              "chars": 192,
              "clipped": false
            }
          ],
          "scopedLocationsMissing": true,
          "outcomeJoined": false
        }
      }
    },
    {
      "owner": "su-449b83a8-a709-43af-9681-768dc6ac744a",
      "request_id": "35042969",
      "ledgerStatus": "ok",
      "candidates": 0,
      "exactArgumentMatches": 0,
      "pairs": [],
      "rejected": [],
      "receiptState": "unresolved",
      "acceptedUnique": false,
      "reason": "no-accepted-complete-pair",
      "cold24Reassessment": {
        "owner": "su-449b83a8-a709-43af-9681-768dc6ac744a",
        "request_id": "35042969",
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
      },
      "cold25Assessment": {
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
      },
      "cold26Assessment": {
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
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch2-424d5.json",
        "outcomeJoined": false
      },
      "cold27Assessment": {
        "request_id": "35042969",
        "owner": "su-449b83a8-a709-43af-9681-768dc6ac744a",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "acceptedPairCount": 0,
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
          },
          {
            "nativeSession": "01a12358-40b3-7071-afa8-73e105e0851b",
            "callPart": 49,
            "resultPart": 50,
            "callTimestamp": "2026-10-10T01:11:12.052+00:00",
            "responseTimestamp": "2026-10-10T01:11:13.116+00:00",
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
            "nativeSession": "01a12358-40b3-7071-afa8-73e105e0851b",
            "callPart": 52,
            "resultPart": 53,
            "callTimestamp": "2026-10-10T01:11:48.863+00:00",
            "responseTimestamp": "2026-10-10T01:11:55.376+00:00",
            "mechanisms": [],
            "conditionalAlternatives": false,
            "chain": null,
            "literalArgsEqual": false,
            "ownerEqual": true,
            "bounds": true,
            "sourceComplete": false,
            "parseErrors": 3,
            "receiptState": "unclassified",
            "statusAgrees": false,
            "completeOriginalPair": false
          }
        ],
        "outcomeJoined": false,
        "assessmentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold27-original45-lineage-augmentation-batch3-424d5.json",
        "sourceLocationAssessment": {
          "request_id": "35042969",
          "owner": "su-449b83a8-a709-43af-9681-768dc6ac744a",
          "ledger": {
            "id": "35042969",
            "tool_name": "session:request-compaction",
            "coord_owner_id": "su-449b83a8-a709-43af-9681-768dc6ac744a",
            "invoked_at": "2026-10-10 01:11:55.169+00",
            "duration_ms": 736,
            "status": "ok",
            "args_json": {
              "focus": "Continue only EI-25520137253860284. Recheck its live claim and existing loop status; let the loop fire after settlement and verify a later loop-origin completion. Then inspect exact metadata_json/args_json for invocations 34768738 and 34994562 and loopArmStages in each serving build. No duplicate loop arm or assignment change.",
              "continueNote": "Resume EI-25520137253860284 from its work-item checkpoint. Keep this turn short: verify the live claim and loop status, allow the existing loop to fire after settlement, and verify a later loop-origin completion. Then inspect both exact invocation rows and build-specific loopArmStages evidence before making any root-cause claim."
            }
          },
          "sourceRefs": [
            "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch2-424d5.json"
          ],
          "nativeSessions": [
            "01a12358-40b3-7071-afa8-73e105e0851b"
          ],
          "originalCandidateCount": 3,
          "lineageCount": 8,
          "unofferedToolUses": [],
          "scopedLocationsMissing": true,
          "outcomeJoined": false
        }
      }
    },
    {
      "owner": "su-ab8cc07f-e903-4467-ac45-a32149258170",
      "request_id": "35044097",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 0,
      "pairs": [],
      "rejected": [],
      "receiptState": "unresolved",
      "acceptedUnique": false,
      "reason": "no-accepted-complete-pair",
      "cold24Reassessment": {
        "owner": "su-ab8cc07f-e903-4467-ac45-a32149258170",
        "request_id": "35044097",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a1234a-0d22-76c3-9b5c-17845a8123b4",
            "callPart": 151,
            "resultPart": 152,
            "callTimestamp": "2026-10-10T01:14:16.889+00:00",
            "responseTimestamp": "2026-10-10T01:14:21.533+00:00",
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
            "nativeSession": "01a1234a-0d22-76c3-9b5c-17845a8123b4",
            "callPart": 153,
            "resultPart": 154,
            "callTimestamp": "2026-10-10T01:14:31.403+00:00",
            "responseTimestamp": "2026-10-10T01:14:37.246+00:00",
            "mechanisms": [
              "ptool-quoted-json"
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
      "cold25Assessment": {
        "request_id": "35044097",
        "owner": "su-ab8cc07f-e903-4467-ac45-a32149258170",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a1234a-0d22-76c3-9b5c-17845a8123b4",
            "callPart": 151,
            "resultPart": 152,
            "callTimestamp": "2026-10-10T01:14:16.889+00:00",
            "responseTimestamp": "2026-10-10T01:14:21.533+00:00",
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
            "nativeSession": "01a1234a-0d22-76c3-9b5c-17845a8123b4",
            "callPart": 153,
            "resultPart": 154,
            "callTimestamp": "2026-10-10T01:14:31.403+00:00",
            "responseTimestamp": "2026-10-10T01:14:37.246+00:00",
            "mechanisms": [
              "ptool-quoted-json"
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
      "cold26Assessment": {
        "request_id": "35044097",
        "owner": "su-ab8cc07f-e903-4467-ac45-a32149258170",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a1234a-0d22-76c3-9b5c-17845a8123b4",
            "callPart": 151,
            "resultPart": 152,
            "callTimestamp": "2026-10-10T01:14:16.889+00:00",
            "responseTimestamp": "2026-10-10T01:14:21.533+00:00",
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
            "nativeSession": "01a1234a-0d22-76c3-9b5c-17845a8123b4",
            "callPart": 153,
            "resultPart": 154,
            "callTimestamp": "2026-10-10T01:14:31.403+00:00",
            "responseTimestamp": "2026-10-10T01:14:37.246+00:00",
            "mechanisms": [
              "ptool-quoted-json"
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
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch3-424d5.json",
        "outcomeJoined": false
      },
      "cold27Assessment": {
        "request_id": "35044097",
        "owner": "su-ab8cc07f-e903-4467-ac45-a32149258170",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "acceptedPairCount": 0,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a1234a-0d22-76c3-9b5c-17845a8123b4",
            "callPart": 149,
            "resultPart": 150,
            "callTimestamp": "2026-10-10T01:13:58.66+00:00",
            "responseTimestamp": "2026-10-10T01:14:01.864+00:00",
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
            "nativeSession": "01a1234a-0d22-76c3-9b5c-17845a8123b4",
            "callPart": 151,
            "resultPart": 152,
            "callTimestamp": "2026-10-10T01:14:16.889+00:00",
            "responseTimestamp": "2026-10-10T01:14:21.533+00:00",
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
            "nativeSession": "01a1234a-0d22-76c3-9b5c-17845a8123b4",
            "callPart": 153,
            "resultPart": 154,
            "callTimestamp": "2026-10-10T01:14:31.403+00:00",
            "responseTimestamp": "2026-10-10T01:14:37.246+00:00",
            "mechanisms": [
              "ptool-quoted-json"
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
          },
          {
            "nativeSession": "01a12360-da31-7753-8b52-6276d176e0d8",
            "callPart": 4,
            "resultPart": 5,
            "callTimestamp": "2026-10-10T01:15:31.458+00:00",
            "responseTimestamp": "2026-10-10T01:15:31.514+00:00",
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
            "nativeSession": "01a12360-da31-7753-8b52-6276d176e0d8",
            "callPart": 6,
            "resultPart": 7,
            "callTimestamp": "2026-10-10T01:15:34.115+00:00",
            "responseTimestamp": "2026-10-10T01:15:34.282+00:00",
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
        "outcomeJoined": false,
        "assessmentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold27-original45-lineage-augmentation-batch3-424d5.json",
        "sourceLocationAssessment": {
          "request_id": "35044097",
          "owner": "su-ab8cc07f-e903-4467-ac45-a32149258170",
          "ledger": {
            "id": "35044097",
            "tool_name": "session:request-compaction",
            "coord_owner_id": "su-ab8cc07f-e903-4467-ac45-a32149258170",
            "invoked_at": "2026-10-10 01:14:36.716+00",
            "duration_ms": 2135,
            "status": "ok",
            "args_json": {
              "focus": "Resume fleet-scoped recovery on WI-10007323. It is open and claimed by su-ab8cc07f-e903-4467-ac45-a32149258170; checkpoint rebuilt and verified (hash 195dad85f377, 37-owner census, 4 checks). This continuation reviewed EI-25248391444384694, EI-25226279926810608 and EI-25243638346303177; requests remain pickup-unconfirmed. Next original row: EI-25238385467055867 / su-449d831c-b3e3-4fad-8816-cc35d56c30cc. Read its current scope/checks/walls first. Recheck prior requests only on reply or new pickup evidence. Loop active, cold, rewakeGuaranteed=true at 01:13:58Z. No source edits/tests.",
              "continueNote": "Continue this same fleet lane. Verify identity, parent claim/checkpoint and loop status, then inspect EI-25238385467055867's current saved scope/checks/walls. Never infer pickup from queued/woken. A prior orientation flagged three tool calls in the 00:50Z carry gap; sessions:read was unpinned, sessions:search ingest degraded, and activity:tool-log exposed only session_request_compaction at 00:50:08.380, so two calls remain unverified. Do not infer a report or repeat an action from that gap; the parent checkpoint records this uncertainty."
            }
          },
          "sourceRefs": [
            "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch3-424d5.json"
          ],
          "nativeSessions": [
            "01a1234a-0d22-76c3-9b5c-17845a8123b4",
            "01a12360-da31-7753-8b52-6276d176e0d8"
          ],
          "originalCandidateCount": 5,
          "lineageCount": 12,
          "unofferedToolUses": [
            {
              "session_id": "01a12360-da31-7753-8b52-6276d176e0d8",
              "part_idx": 8,
              "tool_name": "exec",
              "chars": 100,
              "clipped": false
            }
          ],
          "scopedLocationsMissing": true,
          "outcomeJoined": false
        }
      }
    },
    {
      "owner": "su-b7ae044b-c702-4275-8857-d8c0943bc6f6",
      "request_id": "35045161",
      "ledgerStatus": "ok",
      "candidates": 0,
      "exactArgumentMatches": 0,
      "pairs": [],
      "rejected": [],
      "receiptState": "unresolved",
      "acceptedUnique": false,
      "reason": "no-accepted-complete-pair",
      "cold24Reassessment": {
        "owner": "su-b7ae044b-c702-4275-8857-d8c0943bc6f6",
        "request_id": "35045161",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [],
        "acceptedPairCount": 0,
        "outcomeJoined": false
      },
      "cold25Assessment": {
        "request_id": "35045161",
        "owner": "su-b7ae044b-c702-4275-8857-d8c0943bc6f6",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [],
        "acceptedPairCount": 0,
        "outcomeJoined": false
      },
      "cold26Assessment": {
        "request_id": "35045161",
        "owner": "su-b7ae044b-c702-4275-8857-d8c0943bc6f6",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [],
        "acceptedPairCount": 0,
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch3-424d5.json",
        "outcomeJoined": false
      },
      "cold27Assessment": {
        "request_id": "35045161",
        "owner": "su-b7ae044b-c702-4275-8857-d8c0943bc6f6",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "acceptedPairCount": 0,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a1234d-de07-7972-bec8-6771e5714d38",
            "callPart": 125,
            "resultPart": 126,
            "callTimestamp": "2026-10-10T01:17:42.88+00:00",
            "responseTimestamp": "2026-10-10T01:17:47.035+00:00",
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
        "outcomeJoined": false,
        "assessmentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold27-original45-lineage-augmentation-batch3-424d5.json",
        "sourceLocationAssessment": {
          "request_id": "35045161",
          "owner": "su-b7ae044b-c702-4275-8857-d8c0943bc6f6",
          "ledger": {
            "id": "35045161",
            "tool_name": "session:request-compaction",
            "coord_owner_id": "su-b7ae044b-c702-4275-8857-d8c0943bc6f6",
            "invoked_at": "2026-10-10 01:17:46.77+00",
            "duration_ms": 631,
            "status": "ok",
            "args_json": {
              "focus": "Finish EI-25394335063815313: current-build staging scorecards repair cleanup verified; complete with rootCauseVerification and cite saved 211/211 focused-test report. Preserve the live git-sync headroom wall (latest routine below 40.28 GB reserve), WI-10007570 is task outside the fleet bug-only spec, leader pickup unconfirmed after two wake-required messages; do not retry sync until reserve recovers. Then pull next fleet-admitted bug.",
              "autoContinue": true
            }
          },
          "sourceRefs": [
            "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch3-424d5.json"
          ],
          "nativeSessions": [
            "01a1234d-de07-7972-bec8-6771e5714d38"
          ],
          "originalCandidateCount": 1,
          "lineageCount": 3,
          "unofferedToolUses": [],
          "scopedLocationsMissing": true,
          "outcomeJoined": false
        }
      }
    },
    {
      "owner": "su-960a52e7-9b11-42ac-8fe9-7e5e7e0da441",
      "request_id": "35045222",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a12354-76df-7230-8a3e-7b5bc95a62ef",
          "callPart": 65,
          "resultPart": 66,
          "literalArgsEqual": true,
          "ledgerOwner": "su-960a52e7-9b11-42ac-8fe9-7e5e7e0da441",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-10 01:17:56.139+00",
          "durationMs": 660,
          "derivedDispatchStart": "2026-10-10T01:17:55.479Z",
          "callTimestamp": "2026-10-10T01:17:53.241+00:00",
          "responseTimestamp": "2026-10-10T01:17:56.361+00:00",
          "callBeforeDispatchMs": 2238,
          "responseAfterSettleMs": 222,
          "bounds": true,
          "noAmbiguity": true,
          "error": "no-leading-json-format-or-complete-json-stream",
          "state": "unclassified",
          "statusAgrees": false,
          "accepted": false,
          "sourceComplete": false
        }
      ],
      "rejected": [],
      "receiptState": "unresolved",
      "acceptedUnique": false,
      "reason": "no-accepted-complete-pair",
      "cold24Reassessment": {
        "owner": "su-960a52e7-9b11-42ac-8fe9-7e5e7e0da441",
        "request_id": "35045222",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a12354-76df-7230-8a3e-7b5bc95a62ef",
            "callPart": 65,
            "resultPart": 66,
            "callTimestamp": "2026-10-10T01:17:53.241+00:00",
            "responseTimestamp": "2026-10-10T01:17:56.361+00:00",
            "mechanisms": [
              "invoke"
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
      "cold25Assessment": {
        "request_id": "35045222",
        "owner": "su-960a52e7-9b11-42ac-8fe9-7e5e7e0da441",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a12354-76df-7230-8a3e-7b5bc95a62ef",
            "callPart": 65,
            "resultPart": 66,
            "callTimestamp": "2026-10-10T01:17:53.241+00:00",
            "responseTimestamp": "2026-10-10T01:17:56.361+00:00",
            "mechanisms": [
              "invoke"
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
      "cold26Assessment": {
        "request_id": "35045222",
        "owner": "su-960a52e7-9b11-42ac-8fe9-7e5e7e0da441",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a12354-76df-7230-8a3e-7b5bc95a62ef",
            "callPart": 65,
            "resultPart": 66,
            "callTimestamp": "2026-10-10T01:17:53.241+00:00",
            "responseTimestamp": "2026-10-10T01:17:56.361+00:00",
            "mechanisms": [
              "invoke"
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
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch3-424d5.json",
        "outcomeJoined": false
      },
      "cold27Assessment": {
        "request_id": "35045222",
        "owner": "su-960a52e7-9b11-42ac-8fe9-7e5e7e0da441",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "acceptedPairCount": 0,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a12354-76df-7230-8a3e-7b5bc95a62ef",
            "callPart": 63,
            "resultPart": 64,
            "callTimestamp": "2026-10-10T01:17:27.927+00:00",
            "responseTimestamp": "2026-10-10T01:17:29.302+00:00",
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
            "nativeSession": "01a12354-76df-7230-8a3e-7b5bc95a62ef",
            "callPart": 65,
            "resultPart": 66,
            "callTimestamp": "2026-10-10T01:17:53.241+00:00",
            "responseTimestamp": "2026-10-10T01:17:56.361+00:00",
            "mechanisms": [
              "invoke"
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
        "outcomeJoined": false,
        "assessmentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold27-original45-lineage-augmentation-batch3-424d5.json",
        "sourceLocationAssessment": {
          "request_id": "35045222",
          "owner": "su-960a52e7-9b11-42ac-8fe9-7e5e7e0da441",
          "ledger": {
            "id": "35045222",
            "tool_name": "session:request-compaction",
            "coord_owner_id": "su-960a52e7-9b11-42ac-8fe9-7e5e7e0da441",
            "invoked_at": "2026-10-10 01:17:56.139+00",
            "duration_ms": 660,
            "status": "ok",
            "args_json": {
              "focus": "Resume EI-25522606742920561 from the refreshed checkpoint. Resolve pinned current model/account choices from provider evidence, then run focused installed PUI acceptance using archive /dev/shm/pcv/pui-candidate-81c209358cf5-su-960a52e7-20261010T0110Z/pui-0.1.0-linux-x86_64.tar.gz (SHA256 14c4c521b14e53172bb58583524bf63b35ea534e6eb5a6885dfc7216d7d1caa5): real Claude/OMP OS-process restart+usage and Codex rendered Bash label journey. Preserve per-engine evidence, observe native readiness, update root-cause verification before any full formal matrix.",
              "autoContinue": true
            }
          },
          "sourceRefs": [
            "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch3-424d5.json"
          ],
          "nativeSessions": [
            "01a12354-76df-7230-8a3e-7b5bc95a62ef"
          ],
          "originalCandidateCount": 2,
          "lineageCount": 5,
          "unofferedToolUses": [],
          "scopedLocationsMissing": true,
          "outcomeJoined": false
        }
      }
    },
    {
      "owner": "su-3067d842-6f5a-41ad-bada-9a47df0ea9a6",
      "request_id": "35046578",
      "ledgerStatus": "ok",
      "candidates": 0,
      "exactArgumentMatches": 0,
      "pairs": [],
      "rejected": [],
      "receiptState": "unresolved",
      "acceptedUnique": false,
      "reason": "no-accepted-complete-pair",
      "cold24Reassessment": {
        "owner": "su-3067d842-6f5a-41ad-bada-9a47df0ea9a6",
        "request_id": "35046578",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a12353-79f3-73f3-aa5d-89fd463e5c5b",
            "callPart": 121,
            "resultPart": 122,
            "callTimestamp": "2026-10-10T01:20:31.694+00:00",
            "responseTimestamp": "2026-10-10T01:20:48.884+00:00",
            "mechanisms": [
              "ptool-quoted-json"
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
          },
          {
            "nativeSession": "01a12353-79f3-73f3-aa5d-89fd463e5c5b",
            "callPart": 123,
            "resultPart": 124,
            "callTimestamp": "2026-10-10T01:21:28.146+00:00",
            "responseTimestamp": "2026-10-10T01:21:41.741+00:00",
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
          }
        ],
        "acceptedPairCount": 0,
        "outcomeJoined": false
      },
      "cold25Assessment": {
        "request_id": "35046578",
        "owner": "su-3067d842-6f5a-41ad-bada-9a47df0ea9a6",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a12353-79f3-73f3-aa5d-89fd463e5c5b",
            "callPart": 121,
            "resultPart": 122,
            "callTimestamp": "2026-10-10T01:20:31.694+00:00",
            "responseTimestamp": "2026-10-10T01:20:48.884+00:00",
            "mechanisms": [
              "ptool-quoted-json"
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
          },
          {
            "nativeSession": "01a12353-79f3-73f3-aa5d-89fd463e5c5b",
            "callPart": 123,
            "resultPart": 124,
            "callTimestamp": "2026-10-10T01:21:28.146+00:00",
            "responseTimestamp": "2026-10-10T01:21:41.741+00:00",
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
          }
        ],
        "acceptedPairCount": 0,
        "outcomeJoined": false
      },
      "cold26Assessment": {
        "request_id": "35046578",
        "owner": "su-3067d842-6f5a-41ad-bada-9a47df0ea9a6",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a12353-79f3-73f3-aa5d-89fd463e5c5b",
            "callPart": 121,
            "resultPart": 122,
            "callTimestamp": "2026-10-10T01:20:31.694+00:00",
            "responseTimestamp": "2026-10-10T01:20:48.884+00:00",
            "mechanisms": [
              "ptool-quoted-json"
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
          },
          {
            "nativeSession": "01a12353-79f3-73f3-aa5d-89fd463e5c5b",
            "callPart": 123,
            "resultPart": 124,
            "callTimestamp": "2026-10-10T01:21:28.146+00:00",
            "responseTimestamp": "2026-10-10T01:21:41.741+00:00",
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
          }
        ],
        "acceptedPairCount": 0,
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch3-424d5.json",
        "outcomeJoined": false
      },
      "cold27Assessment": {
        "request_id": "35046578",
        "owner": "su-3067d842-6f5a-41ad-bada-9a47df0ea9a6",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "acceptedPairCount": 0,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a12353-79f3-73f3-aa5d-89fd463e5c5b",
            "callPart": 119,
            "resultPart": 120,
            "callTimestamp": "2026-10-10T01:20:17.347+00:00",
            "responseTimestamp": "2026-10-10T01:20:21.506+00:00",
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
            "nativeSession": "01a12353-79f3-73f3-aa5d-89fd463e5c5b",
            "callPart": 121,
            "resultPart": 122,
            "callTimestamp": "2026-10-10T01:20:31.694+00:00",
            "responseTimestamp": "2026-10-10T01:20:48.884+00:00",
            "mechanisms": [
              "ptool-quoted-json"
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
          },
          {
            "nativeSession": "01a12353-79f3-73f3-aa5d-89fd463e5c5b",
            "callPart": 123,
            "resultPart": 124,
            "callTimestamp": "2026-10-10T01:21:28.146+00:00",
            "responseTimestamp": "2026-10-10T01:21:41.741+00:00",
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
          }
        ],
        "outcomeJoined": false,
        "assessmentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold27-original45-lineage-augmentation-batch3-424d5.json",
        "sourceLocationAssessment": {
          "request_id": "35046578",
          "owner": "su-3067d842-6f5a-41ad-bada-9a47df0ea9a6",
          "ledger": {
            "id": "35046578",
            "tool_name": "session:request-compaction",
            "coord_owner_id": "su-3067d842-6f5a-41ad-bada-9a47df0ea9a6",
            "invoked_at": "2026-10-10 01:20:47.699+00",
            "duration_ms": 5535,
            "status": "ok",
            "args_json": {
              "focus": "Continue the verified fleet lane on EI-25501457254010553. Work-item checkpoint is verified at hash 9a9865a8319a; cold loop checkpoint is verified at hash a1780270eff4; loop status confirmed active with rewakeGuaranteed=true. Fresh scans at 2026-10-10T01:13:27.753Z found only known anchor 34922570 and zero coord:inbox verifier-phase matches; both positive controls passed. Corrected the prior fixed 24h33m aggregate label in comment 1169753; true rolling 24h at 01:13:50.497Z counted 366 retained rows, 40 tools, 4 hosts, 24 processes, 17 builds, 6 coord:inbox, phases 301/17/48. Physical queue/root cause remain unknown. Next wake actions are in both checkpoints. Do not touch terminal EI-25545919624955268 or mismatched EI-25551318421508773. Direct MCP wrapper transport errors were captured; use ptool, and checkpoint schema mismatch was captured before successful staging :3170 write.",
              "autoContinue": true
            }
          },
          "sourceRefs": [
            "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch3-424d5.json"
          ],
          "nativeSessions": [
            "01a12353-79f3-73f3-aa5d-89fd463e5c5b"
          ],
          "originalCandidateCount": 3,
          "lineageCount": 7,
          "unofferedToolUses": [],
          "scopedLocationsMissing": true,
          "outcomeJoined": false
        }
      }
    },
    {
      "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
      "request_id": "35047650",
      "ledgerStatus": "ok",
      "candidates": 0,
      "exactArgumentMatches": 0,
      "pairs": [],
      "rejected": [],
      "receiptState": "unresolved",
      "acceptedUnique": false,
      "reason": "no-accepted-complete-pair",
      "cold24Reassessment": {
        "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
        "request_id": "35047650",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a1234b-2ad5-7db0-86b8-4dcb0f9aa366",
            "callPart": 167,
            "resultPart": 168,
            "callTimestamp": "2026-10-10T01:22:36.494+00:00",
            "responseTimestamp": "2026-10-10T01:22:55.034+00:00",
            "mechanisms": [
              "ptool-quoted-json"
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
      "cold25Assessment": {
        "request_id": "35047650",
        "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a1234b-2ad5-7db0-86b8-4dcb0f9aa366",
            "callPart": 167,
            "resultPart": 168,
            "callTimestamp": "2026-10-10T01:22:36.494+00:00",
            "responseTimestamp": "2026-10-10T01:22:55.034+00:00",
            "mechanisms": [
              "ptool-quoted-json"
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
      "cold26Assessment": {
        "request_id": "35047650",
        "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a1234b-2ad5-7db0-86b8-4dcb0f9aa366",
            "callPart": 167,
            "resultPart": 168,
            "callTimestamp": "2026-10-10T01:22:36.494+00:00",
            "responseTimestamp": "2026-10-10T01:22:55.034+00:00",
            "mechanisms": [
              "ptool-quoted-json"
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
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch3-424d5.json",
        "outcomeJoined": false
      },
      "cold27Assessment": {
        "request_id": "35047650",
        "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "acceptedPairCount": 0,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a1234b-2ad5-7db0-86b8-4dcb0f9aa366",
            "callPart": 163,
            "resultPart": 164,
            "callTimestamp": "2026-10-10T01:21:54.436+00:00",
            "responseTimestamp": "2026-10-10T01:22:01.038+00:00",
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
            "nativeSession": "01a1234b-2ad5-7db0-86b8-4dcb0f9aa366",
            "callPart": 165,
            "resultPart": 166,
            "callTimestamp": "2026-10-10T01:22:14.227+00:00",
            "responseTimestamp": "2026-10-10T01:22:27.306+00:00",
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
            "nativeSession": "01a1234b-2ad5-7db0-86b8-4dcb0f9aa366",
            "callPart": 167,
            "resultPart": 168,
            "callTimestamp": "2026-10-10T01:22:36.494+00:00",
            "responseTimestamp": "2026-10-10T01:22:55.034+00:00",
            "mechanisms": [
              "ptool-quoted-json"
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
          },
          {
            "nativeSession": "01a12368-3a80-78b2-b196-a4b27f28a933",
            "callPart": 4,
            "resultPart": 5,
            "callTimestamp": "2026-10-10T01:23:31.772+00:00",
            "responseTimestamp": "2026-10-10T01:23:37.776+00:00",
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
            "nativeSession": "01a12368-3a80-78b2-b196-a4b27f28a933",
            "callPart": 6,
            "resultPart": 7,
            "callTimestamp": "2026-10-10T01:23:47.429+00:00",
            "responseTimestamp": "2026-10-10T01:23:56.277+00:00",
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
          }
        ],
        "outcomeJoined": false,
        "assessmentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold27-original45-lineage-augmentation-batch3-424d5.json",
        "sourceLocationAssessment": {
          "request_id": "35047650",
          "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
          "ledger": {
            "id": "35047650",
            "tool_name": "session:request-compaction",
            "coord_owner_id": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
            "invoked_at": "2026-10-10 01:22:52.513+00",
            "duration_ms": 11156,
            "status": "ok",
            "args_json": {
              "focus": "Continue fleet item EI-25546536704309473 only. Owner identity verified as su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5. Post-compaction recovery marker is complete; do not re-orient unless its control hash mismatches. Live item checkpoint contentHash d3ff421cf7d3 (updated after recording the :3170 transport capture as EI-25553380783967720); loop checkpoint contentHash 7814022726c2, cold loop active with rewakeGuaranteed=true and pending inbox-wake await. Current finding: original stale-artifact denial is not reproduced by this session across :9271, :3170, :9071. Both proxy runtimes were restarted through dev:restart; health now says current. :3170 had a transient ECONNREFUSED during a checkpoint call, captured separately; later health says it is up. Original reporter su-ce4c4481-9aa5-4fc0-bfac-6446e16bd98f was asked for same-session replay; coord:send msg_id coord-send-c0fb210fcf05b5cbcb4ce826c7a7cf5879855f4846c77d4bc56f7fbd255ee892, wake queued but pickup unconfirmed. Next wake: inspect inbox-wake payload/reply, verify pickup, then inspect same-session denial or historical server-side record. Keep EI-255465 open until causal evidence or supported non-repro disposition; no tests/files changed. Do not act on carried EI-253260 or EI-255513; neither is held by this session.",
              "autoContinue": true
            }
          },
          "sourceRefs": [
            "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch3-424d5.json"
          ],
          "nativeSessions": [
            "01a1234b-2ad5-7db0-86b8-4dcb0f9aa366",
            "01a12368-3a80-78b2-b196-a4b27f28a933"
          ],
          "originalCandidateCount": 5,
          "lineageCount": 12,
          "unofferedToolUses": [
            {
              "session_id": "01a12368-3a80-78b2-b196-a4b27f28a933",
              "part_idx": 8,
              "tool_name": "exec",
              "chars": 498,
              "clipped": false
            }
          ],
          "scopedLocationsMissing": true,
          "outcomeJoined": false
        }
      }
    },
    {
      "request_id": "35058458",
      "owner": "su-b7ae044b-c702-4275-8857-d8c0943bc6f6",
      "acceptedUnique": true,
      "completeOriginalPair": true,
      "receiptState": "queued",
      "pairs": [
        {
          "nativeSession": "01a12366-709f-7563-883f-29a8b509fa28",
          "callPart": 92,
          "resultPart": 93,
          "callTimestamp": "2026-10-10T01:42:38.818+00:00",
          "responseTimestamp": "2026-10-10T01:42:47.694+00:00",
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
      "outcomeJoined": false,
      "assessmentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch3-424d5.json",
      "instrumentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold25-native-analysis-instrument-424d5.json"
    },
    {
      "request_id": "35063976",
      "owner": "su-312c90f2-a3bd-4c92-ac4e-4eae40ae2647",
      "acceptedUnique": true,
      "completeOriginalPair": true,
      "receiptState": "queued",
      "pairs": [
        {
          "nativeSession": "01a12367-db6e-7d32-b369-cb7e792a16e4",
          "callPart": 157,
          "resultPart": 158,
          "callTimestamp": "2026-10-10T01:54:16.017+00:00",
          "responseTimestamp": "2026-10-10T01:54:47.058+00:00",
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
          "nativeSession": "01a12367-db6e-7d32-b369-cb7e792a16e4",
          "callPart": 157,
          "resultPart": 160,
          "callTimestamp": "2026-10-10T01:54:16.017+00:00",
          "responseTimestamp": "2026-10-10T01:55:23.789+00:00",
          "mechanisms": [
            "native-wrapper"
          ],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "71",
            "links": [
              {
                "yieldPart": 158,
                "waitPart": 159,
                "precedingCallPart": 157
              }
            ],
            "waitPart": 159,
            "originalCallPart": 157
          },
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
          "nativeSession": "01a12367-db6e-7d32-b369-cb7e792a16e4",
          "callPart": 157,
          "resultPart": 163,
          "callTimestamp": "2026-10-10T01:54:16.017+00:00",
          "responseTimestamp": "2026-10-10T01:55:59.527+00:00",
          "mechanisms": [
            "native-wrapper"
          ],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "71",
            "links": [
              {
                "yieldPart": 158,
                "waitPart": 159,
                "precedingCallPart": 157
              },
              {
                "yieldPart": 160,
                "waitPart": 162,
                "precedingCallPart": 159
              }
            ],
            "waitPart": 162,
            "originalCallPart": 157
          },
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
          "nativeSession": "01a12367-db6e-7d32-b369-cb7e792a16e4",
          "callPart": 157,
          "resultPart": 165,
          "callTimestamp": "2026-10-10T01:54:16.017+00:00",
          "responseTimestamp": "2026-10-10T01:56:04.149+00:00",
          "mechanisms": [
            "native-wrapper"
          ],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "71",
            "links": [
              {
                "yieldPart": 158,
                "waitPart": 159,
                "precedingCallPart": 157
              },
              {
                "yieldPart": 160,
                "waitPart": 162,
                "precedingCallPart": 159
              },
              {
                "yieldPart": 163,
                "waitPart": 164,
                "precedingCallPart": 162
              }
            ],
            "waitPart": 164,
            "originalCallPart": 157
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
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch3-424d5.json",
      "outcomeJoined": false,
      "assessmentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold26-native-assessment-original49-424d5.json",
      "instrumentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold26-native-analysis-instrument-424d5.json"
    },
    {
      "request_id": "35064368",
      "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
      "acceptedUnique": true,
      "completeOriginalPair": true,
      "receiptState": "queued",
      "pairs": [
        {
          "nativeSession": "01a12368-3a80-78b2-b196-a4b27f28a933",
          "callPart": 126,
          "resultPart": 127,
          "callTimestamp": "2026-10-10T01:55:07.723+00:00",
          "responseTimestamp": "2026-10-10T01:55:38.766+00:00",
          "mechanisms": [
            "ptool-quoted-json"
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
          "nativeSession": "01a12368-3a80-78b2-b196-a4b27f28a933",
          "callPart": 126,
          "resultPart": 129,
          "callTimestamp": "2026-10-10T01:55:07.723+00:00",
          "responseTimestamp": "2026-10-10T01:56:15.438+00:00",
          "mechanisms": [
            "ptool-quoted-json"
          ],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "56",
            "links": [
              {
                "yieldPart": 127,
                "waitPart": 128,
                "precedingCallPart": 126
              }
            ],
            "waitPart": 128,
            "originalCallPart": 126
          },
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
          "nativeSession": "01a12368-3a80-78b2-b196-a4b27f28a933",
          "callPart": 126,
          "resultPart": 131,
          "callTimestamp": "2026-10-10T01:55:07.723+00:00",
          "responseTimestamp": "2026-10-10T01:56:51.596+00:00",
          "mechanisms": [
            "ptool-quoted-json"
          ],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "56",
            "links": [
              {
                "yieldPart": 127,
                "waitPart": 128,
                "precedingCallPart": 126
              },
              {
                "yieldPart": 129,
                "waitPart": 130,
                "precedingCallPart": 128
              }
            ],
            "waitPart": 130,
            "originalCallPart": 126
          },
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
          "nativeSession": "01a12368-3a80-78b2-b196-a4b27f28a933",
          "callPart": 126,
          "resultPart": 133,
          "callTimestamp": "2026-10-10T01:55:07.723+00:00",
          "responseTimestamp": "2026-10-10T01:56:58.885+00:00",
          "mechanisms": [
            "ptool-quoted-json"
          ],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "56",
            "links": [
              {
                "yieldPart": 127,
                "waitPart": 128,
                "precedingCallPart": 126
              },
              {
                "yieldPart": 129,
                "waitPart": 130,
                "precedingCallPart": 128
              },
              {
                "yieldPart": 131,
                "waitPart": 132,
                "precedingCallPart": 130
              }
            ],
            "waitPart": 132,
            "originalCallPart": 126
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
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch3-424d5.json",
      "outcomeJoined": false,
      "assessmentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold26-native-assessment-original49-424d5.json",
      "instrumentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold26-native-analysis-instrument-424d5.json"
    },
    {
      "owner": "su-f6e9cbee-faee-465e-9281-2743f85a91ab",
      "request_id": "35069597",
      "ledgerStatus": "refused",
      "candidates": 1,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a122a5-50fd-75c1-b5a5-a75c3e496e63",
          "callPart": 495,
          "resultPart": 496,
          "callTimestamp": "2026-10-10T02:09:52.417+00:00",
          "responseTimestamp": "2026-10-10T02:09:52.72+00:00",
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
          "receiptState": "no-host-refused",
          "statusAgrees": true,
          "format": "json",
          "requested": false,
          "respawn": false,
          "error": "no_live_pty_host",
          "completeOriginalPair": true,
          "accepted": true,
          "state": "no-host-refused"
        }
      ],
      "rejected": [],
      "receiptState": "no-host-refused",
      "acceptedUnique": true,
      "reason": null,
      "priorAssessment": {
        "owner": "su-f6e9cbee-faee-465e-9281-2743f85a91ab",
        "request_id": "35069597",
        "ledgerStatus": "refused",
        "candidates": 1,
        "exactArgumentMatches": 1,
        "pairs": [
          {
            "nativeSession": "01a122a5-50fd-75c1-b5a5-a75c3e496e63",
            "callPart": 495,
            "resultPart": 496,
            "literalArgsEqual": true,
            "ledgerOwner": "su-f6e9cbee-faee-465e-9281-2743f85a91ab",
            "ownerEqual": true,
            "ledgerSettle": "2026-10-10 02:09:52.703+00",
            "durationMs": 19,
            "derivedDispatchStart": "2026-10-10T02:09:52.684Z",
            "callTimestamp": "2026-10-10T02:09:52.417+00:00",
            "responseTimestamp": "2026-10-10T02:09:52.72+00:00",
            "callBeforeDispatchMs": 267,
            "responseAfterSettleMs": 17,
            "bounds": true,
            "noAmbiguity": true,
            "format": "json",
            "textBlocks": 1,
            "body": {
              "ok": false,
              "requested": false,
              "respawn": false,
              "error": "no_live_pty_host",
              "carry": "cold",
              "carryNote": {
                "verified": true
              },
              "note": "No live psu-pty host is available, so no carry-respawn was queued. An armed cold loop and saved carry-note do not prove the next turn can be delivered. Keep this process active after flushing state, or relaunch through a managed psu host before relying on a fresh-context boundary."
            },
            "state": "unclassified",
            "statusAgrees": false,
            "accepted": false,
            "sourceComplete": true
          }
        ],
        "rejected": [],
        "receiptState": "unresolved",
        "acceptedUnique": false,
        "reason": "no-accepted-complete-pair"
      },
      "custodySource": "audits/parked-agent-resumption-2026-10-09/r13-cold23-five-original-custody-424d5.json",
      "currentSourceAssessment": {
        "request_id": "35069597",
        "owner": "su-f6e9cbee-faee-465e-9281-2743f85a91ab",
        "completeOriginalPair": true,
        "pairs": [
          {
            "nativeSession": "01a122a5-50fd-75c1-b5a5-a75c3e496e63",
            "callPart": 495,
            "resultPart": 496,
            "callTimestamp": "2026-10-10T02:09:52.417+00:00",
            "responseTimestamp": "2026-10-10T02:09:52.72+00:00",
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
            "receiptState": "no-host-refused",
            "statusAgrees": true,
            "format": "json",
            "requested": false,
            "respawn": false,
            "error": "no_live_pty_host",
            "completeOriginalPair": true
          }
        ],
        "receiptState": "no-host-refused",
        "outcomeJoined": false
      }
    },
    {
      "owner": "su-312c90f2-a3bd-4c92-ac4e-4eae40ae2647",
      "request_id": "35089988",
      "ledgerStatus": "ok",
      "candidates": 2,
      "exactArgumentMatches": 0,
      "pairs": [
        {
          "nativeSession": "01a12386-af1f-7621-951a-227fee9b3df4",
          "callPart": 249,
          "resultPart": 254,
          "callTimestamp": "2026-10-10 02:52:04.339+00",
          "responseTimestamp": "2026-10-09 22:53:33.387-04",
          "mechanisms": [
            "ptool-quoted-json"
          ],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "103",
            "yieldPart": 250,
            "waitPart": 253,
            "originalCallPart": 249
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
          "completeOriginalPair": true,
          "accepted": true,
          "state": "queued"
        }
      ],
      "rejected": [],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null,
      "priorAssessment": {
        "owner": "su-312c90f2-a3bd-4c92-ac4e-4eae40ae2647",
        "request_id": "35089988",
        "ledgerStatus": "ok",
        "candidates": 2,
        "exactArgumentMatches": 0,
        "pairs": [],
        "rejected": [],
        "receiptState": "unresolved",
        "acceptedUnique": false,
        "reason": "no-accepted-complete-pair"
      },
      "custodySource": "audits/parked-agent-resumption-2026-10-09/r13-cold23-remaining-wait-assessment-424d5.json",
      "currentSourceAssessment": {
        "request_id": "35089988",
        "owner": "su-312c90f2-a3bd-4c92-ac4e-4eae40ae2647",
        "completeOriginalPair": true,
        "pairs": [
          {
            "nativeSession": "01a12386-af1f-7621-951a-227fee9b3df4",
            "callPart": 249,
            "resultPart": 252,
            "callTimestamp": "2026-10-10 02:52:04.339+00",
            "responseTimestamp": "2026-10-09 22:53:10.145-04",
            "mechanisms": [
              "ptool-quoted-json"
            ],
            "conditionalAlternatives": false,
            "chain": {
              "cellId": "103",
              "yieldPart": 250,
              "waitPart": 251,
              "originalCallPart": 249
            },
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
            "nativeSession": "01a12386-af1f-7621-951a-227fee9b3df4",
            "callPart": 249,
            "resultPart": 254,
            "callTimestamp": "2026-10-10 02:52:04.339+00",
            "responseTimestamp": "2026-10-09 22:53:33.387-04",
            "mechanisms": [
              "ptool-quoted-json"
            ],
            "conditionalAlternatives": false,
            "chain": {
              "cellId": "103",
              "yieldPart": 250,
              "waitPart": 253,
              "originalCallPart": 249
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
      }
    },
    {
      "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
      "request_id": "35099533",
      "ledgerStatus": "ok",
      "candidates": 0,
      "exactArgumentMatches": 0,
      "pairs": [],
      "rejected": [],
      "receiptState": "unresolved",
      "acceptedUnique": false,
      "reason": "no-accepted-complete-pair",
      "cold24Reassessment": {
        "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
        "request_id": "35099533",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a123b4-6f42-7472-a975-3a2ba6200ff0",
            "callPart": 102,
            "resultPart": 103,
            "callTimestamp": "2026-10-10T03:11:19.842+00:00",
            "responseTimestamp": "2026-10-10T03:11:30.513+00:00",
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
            "nativeSession": "01a123b4-6f42-7472-a975-3a2ba6200ff0",
            "callPart": 106,
            "resultPart": 107,
            "callTimestamp": "2026-10-10T03:12:08.306+00:00",
            "responseTimestamp": "2026-10-10T03:12:37.937+00:00",
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
          },
          {
            "nativeSession": "01a123b4-6f42-7472-a975-3a2ba6200ff0",
            "callPart": 108,
            "resultPart": 109,
            "callTimestamp": "2026-10-10T03:13:22.329+00:00",
            "responseTimestamp": "2026-10-10T03:13:31.891+00:00",
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
      },
      "cold25Assessment": {
        "request_id": "35099533",
        "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a123b4-6f42-7472-a975-3a2ba6200ff0",
            "callPart": 102,
            "resultPart": 103,
            "callTimestamp": "2026-10-10T03:11:19.842+00:00",
            "responseTimestamp": "2026-10-10T03:11:30.513+00:00",
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
            "nativeSession": "01a123b4-6f42-7472-a975-3a2ba6200ff0",
            "callPart": 106,
            "resultPart": 107,
            "callTimestamp": "2026-10-10T03:12:08.306+00:00",
            "responseTimestamp": "2026-10-10T03:12:37.937+00:00",
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
          },
          {
            "nativeSession": "01a123b4-6f42-7472-a975-3a2ba6200ff0",
            "callPart": 108,
            "resultPart": 109,
            "callTimestamp": "2026-10-10T03:13:22.329+00:00",
            "responseTimestamp": "2026-10-10T03:13:31.891+00:00",
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
      },
      "cold26Assessment": {
        "request_id": "35099533",
        "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a123b4-6f42-7472-a975-3a2ba6200ff0",
            "callPart": 102,
            "resultPart": 103,
            "callTimestamp": "2026-10-10T03:11:19.842+00:00",
            "responseTimestamp": "2026-10-10T03:11:30.513+00:00",
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
            "nativeSession": "01a123b4-6f42-7472-a975-3a2ba6200ff0",
            "callPart": 106,
            "resultPart": 107,
            "callTimestamp": "2026-10-10T03:12:08.306+00:00",
            "responseTimestamp": "2026-10-10T03:12:37.937+00:00",
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
          },
          {
            "nativeSession": "01a123b4-6f42-7472-a975-3a2ba6200ff0",
            "callPart": 108,
            "resultPart": 109,
            "callTimestamp": "2026-10-10T03:13:22.329+00:00",
            "responseTimestamp": "2026-10-10T03:13:31.891+00:00",
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
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch3-424d5.json",
        "outcomeJoined": false
      },
      "cold27Assessment": {
        "request_id": "35099533",
        "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "acceptedPairCount": 0,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a123b4-6f42-7472-a975-3a2ba6200ff0",
            "callPart": 102,
            "resultPart": 103,
            "callTimestamp": "2026-10-10T03:11:19.842+00:00",
            "responseTimestamp": "2026-10-10T03:11:30.513+00:00",
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
            "nativeSession": "01a123b4-6f42-7472-a975-3a2ba6200ff0",
            "callPart": 104,
            "resultPart": 105,
            "callTimestamp": "2026-10-10T03:11:38.501+00:00",
            "responseTimestamp": "2026-10-10T03:11:43.784+00:00",
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
            "nativeSession": "01a123b4-6f42-7472-a975-3a2ba6200ff0",
            "callPart": 106,
            "resultPart": 107,
            "callTimestamp": "2026-10-10T03:12:08.306+00:00",
            "responseTimestamp": "2026-10-10T03:12:37.937+00:00",
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
          },
          {
            "nativeSession": "01a123b4-6f42-7472-a975-3a2ba6200ff0",
            "callPart": 108,
            "resultPart": 109,
            "callTimestamp": "2026-10-10T03:13:22.329+00:00",
            "responseTimestamp": "2026-10-10T03:13:31.891+00:00",
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
        "outcomeJoined": false,
        "assessmentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold27-original45-lineage-augmentation-batch3-424d5.json",
        "sourceLocationAssessment": {
          "request_id": "35099533",
          "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
          "ledger": {
            "id": "35099533",
            "tool_name": "session:request-compaction",
            "coord_owner_id": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
            "invoked_at": "2026-10-10 03:12:33.636+00",
            "duration_ms": 14608,
            "status": "ok",
            "args_json": {
              "focus": "Continue EI-25324371882189406. Identity verified; current source path supports compactionLimit but tests were provenance-UNKNOWN after HEAD moved 727f6f0632→e65da5b0fb. Inspect any existing PC_EXECUTED_SOURCE_MAP_OUT evidence before rerunning; if absent, arm original-source capture first. Current CODEX_HOME session-39345 still has native limit 784800 vs managed 250000; cited old home session-35654 is absent. Staging has target source; release does not. No edits or native compaction/restart.",
              "autoContinue": true
            }
          },
          "sourceRefs": [
            "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch3-424d5.json"
          ],
          "nativeSessions": [
            "01a123b4-6f42-7472-a975-3a2ba6200ff0"
          ],
          "originalCandidateCount": 4,
          "lineageCount": 9,
          "unofferedToolUses": [],
          "scopedLocationsMissing": true,
          "outcomeJoined": false
        }
      }
    },
    {
      "owner": "su-faf26552-0633-4081-a250-172c02f07c19",
      "request_id": "35108257",
      "acceptedUnique": true,
      "completeOriginalPair": true,
      "receiptState": "queued",
      "pairs": [
        {
          "nativeSession": "01a123d2-ee6c-7bc1-9a95-34572719bfe8",
          "callPart": 72,
          "resultPart": 73,
          "callTimestamp": "2026-10-10T03:32:20.565+00:00",
          "responseTimestamp": "2026-10-10T03:32:44.738+00:00",
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
      "outcomeJoined": false,
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-native-assessment-batch3-424d5.json"
    },
    {
      "owner": "su-312c90f2-a3bd-4c92-ac4e-4eae40ae2647",
      "request_id": "35109461",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 0,
      "pairs": [],
      "rejected": [
        {
          "session": "01a123bb-3402-7a32-ac21-9d650b1634a4",
          "part": 181,
          "reason": "argument-mismatch"
        }
      ],
      "receiptState": "unresolved",
      "acceptedUnique": false,
      "reason": "no-accepted-complete-pair",
      "cold24Reassessment": {
        "owner": "su-312c90f2-a3bd-4c92-ac4e-4eae40ae2647",
        "request_id": "35109461",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a123bb-3402-7a32-ac21-9d650b1634a4",
            "callPart": 177,
            "resultPart": 178,
            "callTimestamp": "2026-10-10T03:34:44.285+00:00",
            "responseTimestamp": "2026-10-10T03:34:44.474+00:00",
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
            "nativeSession": "01a123bb-3402-7a32-ac21-9d650b1634a4",
            "callPart": 181,
            "resultPart": 182,
            "callTimestamp": "2026-10-10T03:35:07.629+00:00",
            "responseTimestamp": "2026-10-10T03:35:17.09+00:00",
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
      "cold25Assessment": {
        "request_id": "35109461",
        "owner": "su-312c90f2-a3bd-4c92-ac4e-4eae40ae2647",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a123bb-3402-7a32-ac21-9d650b1634a4",
            "callPart": 177,
            "resultPart": 178,
            "callTimestamp": "2026-10-10T03:34:44.285+00:00",
            "responseTimestamp": "2026-10-10T03:34:44.474+00:00",
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
            "nativeSession": "01a123bb-3402-7a32-ac21-9d650b1634a4",
            "callPart": 181,
            "resultPart": 182,
            "callTimestamp": "2026-10-10T03:35:07.629+00:00",
            "responseTimestamp": "2026-10-10T03:35:17.09+00:00",
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
      "cold26Assessment": {
        "request_id": "35109461",
        "owner": "su-312c90f2-a3bd-4c92-ac4e-4eae40ae2647",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a123bb-3402-7a32-ac21-9d650b1634a4",
            "callPart": 177,
            "resultPart": 178,
            "callTimestamp": "2026-10-10T03:34:44.285+00:00",
            "responseTimestamp": "2026-10-10T03:34:44.474+00:00",
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
            "nativeSession": "01a123bb-3402-7a32-ac21-9d650b1634a4",
            "callPart": 181,
            "resultPart": 182,
            "callTimestamp": "2026-10-10T03:35:07.629+00:00",
            "responseTimestamp": "2026-10-10T03:35:17.09+00:00",
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
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch3-424d5.json",
        "outcomeJoined": false
      },
      "cold27Assessment": {
        "request_id": "35109461",
        "owner": "su-312c90f2-a3bd-4c92-ac4e-4eae40ae2647",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "acceptedPairCount": 0,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a123bb-3402-7a32-ac21-9d650b1634a4",
            "callPart": 177,
            "resultPart": 178,
            "callTimestamp": "2026-10-10T03:34:44.285+00:00",
            "responseTimestamp": "2026-10-10T03:34:44.474+00:00",
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
            "nativeSession": "01a123bb-3402-7a32-ac21-9d650b1634a4",
            "callPart": 179,
            "resultPart": 180,
            "callTimestamp": "2026-10-10T03:34:52.042+00:00",
            "responseTimestamp": "2026-10-10T03:34:54.265+00:00",
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
            "nativeSession": "01a123bb-3402-7a32-ac21-9d650b1634a4",
            "callPart": 181,
            "resultPart": 182,
            "callTimestamp": "2026-10-10T03:35:07.629+00:00",
            "responseTimestamp": "2026-10-10T03:35:17.09+00:00",
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
        "outcomeJoined": false,
        "assessmentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold27-original45-lineage-augmentation-batch4-424d5.json",
        "sourceLocationAssessment": {
          "request_id": "35109461",
          "owner": "su-312c90f2-a3bd-4c92-ac4e-4eae40ae2647",
          "ledger": {
            "id": "35109461",
            "tool_name": "session:request-compaction",
            "coord_owner_id": "su-312c90f2-a3bd-4c92-ac4e-4eae40ae2647",
            "invoked_at": "2026-10-10 03:35:15.464+00",
            "duration_ms": 1422,
            "status": "ok",
            "args_json": {
              "focus": "Continue EI-25556584571867080 in the existing papercusp fleet claim-spec lane. Revalidate session identity if needed, inspect the exact listLiveHostsAsync/identity-check path tied by invocation row 35069182 to a 58.861s phase, implement a bounded durable fix with a regression guard and run the targeted project test. Preserve the distinct current 24.840s call profile. Check git-sync settlement for WI-10008036 and resume scheduler:get_next only within the configured fleet claim-spec.",
              "autoContinue": true
            }
          },
          "sourceRefs": [
            "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch3-424d5.json"
          ],
          "nativeSessions": [
            "01a123bb-3402-7a32-ac21-9d650b1634a4"
          ],
          "originalCandidateCount": 3,
          "lineageCount": 7,
          "unofferedToolUses": [],
          "scopedLocationsMissing": true,
          "outcomeJoined": false
        }
      }
    },
    {
      "owner": "su-f6b6fcca-f4f9-484f-86ca-974378824a67",
      "request_id": "35115120",
      "ledgerStatus": "ok",
      "candidates": 2,
      "exactArgumentMatches": 0,
      "pairs": [
        {
          "nativeSession": "01a123dd-2b69-75b2-8323-c43e797bca78",
          "callPart": 89,
          "resultPart": 90,
          "callTimestamp": "2026-10-10T03:47:00.381+00:00",
          "responseTimestamp": "2026-10-10T03:47:01.403+00:00",
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
          "completeOriginalPair": true,
          "accepted": true,
          "state": "queued"
        }
      ],
      "rejected": [
        {
          "session": "01a123dd-2b69-75b2-8323-c43e797bca78",
          "part": 89,
          "reason": "Error: nonliteral property"
        }
      ],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null,
      "priorAssessment": {
        "owner": "su-f6b6fcca-f4f9-484f-86ca-974378824a67",
        "request_id": "35115120",
        "ledgerStatus": "ok",
        "candidates": 2,
        "exactArgumentMatches": 0,
        "pairs": [],
        "rejected": [
          {
            "session": "01a123dd-2b69-75b2-8323-c43e797bca78",
            "part": 89,
            "reason": "Error: nonliteral property"
          }
        ],
        "receiptState": "unresolved",
        "acceptedUnique": false,
        "reason": "no-accepted-complete-pair"
      },
      "custodySource": "audits/parked-agent-resumption-2026-10-09/r13-cold23-five-original-custody-424d5.json",
      "currentSourceAssessment": {
        "request_id": "35115120",
        "owner": "su-f6b6fcca-f4f9-484f-86ca-974378824a67",
        "completeOriginalPair": true,
        "pairs": [
          {
            "nativeSession": "01a123dd-2b69-75b2-8323-c43e797bca78",
            "callPart": 89,
            "resultPart": 90,
            "callTimestamp": "2026-10-10T03:47:00.381+00:00",
            "responseTimestamp": "2026-10-10T03:47:01.403+00:00",
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
      }
    },
    {
      "owner": "su-312c90f2-a3bd-4c92-ac4e-4eae40ae2647",
      "request_id": "35119644",
      "acceptedUnique": true,
      "completeOriginalPair": true,
      "receiptState": "queued",
      "pairs": [
        {
          "nativeSession": "01a123e1-9727-72a2-b3d3-c4f01fe4b1ed",
          "callPart": 116,
          "resultPart": 117,
          "callTimestamp": "2026-10-10T03:55:12.063+00:00",
          "responseTimestamp": "2026-10-10T03:55:30.782+00:00",
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
          "nativeSession": "01a123e1-9727-72a2-b3d3-c4f01fe4b1ed",
          "callPart": 118,
          "resultPart": 119,
          "callTimestamp": "2026-10-10T03:56:01.867+00:00",
          "responseTimestamp": "2026-10-10T03:56:30.316+00:00",
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
      "outcomeJoined": false,
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-native-assessment-batch3-424d5.json"
    },
    {
      "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
      "request_id": "35120408",
      "acceptedUnique": true,
      "completeOriginalPair": true,
      "receiptState": "queued",
      "pairs": [
        {
          "nativeSession": "01a123e1-8631-7722-98ac-33f2b3786d4f",
          "callPart": 150,
          "resultPart": 151,
          "callTimestamp": "2026-10-10T03:57:01.877+00:00",
          "responseTimestamp": "2026-10-10T03:57:15.263+00:00",
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
          "nativeSession": "01a123e1-8631-7722-98ac-33f2b3786d4f",
          "callPart": 154,
          "resultPart": 155,
          "callTimestamp": "2026-10-10T03:57:34.569+00:00",
          "responseTimestamp": "2026-10-10T03:57:34.961+00:00",
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
          "nativeSession": "01a123e1-8631-7722-98ac-33f2b3786d4f",
          "callPart": 156,
          "resultPart": 157,
          "callTimestamp": "2026-10-10T03:57:42.109+00:00",
          "responseTimestamp": "2026-10-10T03:58:04.747+00:00",
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
      "outcomeJoined": false,
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-native-assessment-batch3-424d5.json"
    },
    {
      "owner": "su-faf26552-0633-4081-a250-172c02f07c19",
      "request_id": "35121480",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 0,
      "pairs": [],
      "rejected": [],
      "receiptState": "unresolved",
      "acceptedUnique": false,
      "reason": "no-accepted-complete-pair",
      "cold24Reassessment": {
        "owner": "su-faf26552-0633-4081-a250-172c02f07c19",
        "request_id": "35121480",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a123df-0540-7073-ab0f-160863c68c25",
            "callPart": 139,
            "resultPart": 140,
            "callTimestamp": "2026-10-10T03:59:38.018+00:00",
            "responseTimestamp": "2026-10-10T04:00:09.081+00:00",
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
            "nativeSession": "01a123df-0540-7073-ab0f-160863c68c25",
            "callPart": 139,
            "resultPart": 143,
            "callTimestamp": "2026-10-10T03:59:38.018+00:00",
            "responseTimestamp": "2026-10-10T04:00:26.923+00:00",
            "mechanisms": [],
            "conditionalAlternatives": false,
            "chain": {
              "cellId": "65",
              "yieldPart": 140,
              "waitPart": 142,
              "originalCallPart": 139
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
            "nativeSession": "01a123df-0540-7073-ab0f-160863c68c25",
            "callPart": 142,
            "resultPart": 145,
            "callTimestamp": "2026-10-10T04:00:15.911+00:00",
            "responseTimestamp": "2026-10-10T04:00:31.129+00:00",
            "mechanisms": [],
            "conditionalAlternatives": false,
            "chain": {
              "cellId": "65",
              "yieldPart": 143,
              "waitPart": 144,
              "originalCallPart": 142
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
      "cold25Assessment": {
        "request_id": "35121480",
        "owner": "su-faf26552-0633-4081-a250-172c02f07c19",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a123df-0540-7073-ab0f-160863c68c25",
            "callPart": 139,
            "resultPart": 140,
            "callTimestamp": "2026-10-10T03:59:38.018+00:00",
            "responseTimestamp": "2026-10-10T04:00:09.081+00:00",
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
            "nativeSession": "01a123df-0540-7073-ab0f-160863c68c25",
            "callPart": 139,
            "resultPart": 143,
            "callTimestamp": "2026-10-10T03:59:38.018+00:00",
            "responseTimestamp": "2026-10-10T04:00:26.923+00:00",
            "mechanisms": [],
            "conditionalAlternatives": false,
            "chain": {
              "cellId": "65",
              "yieldPart": 140,
              "waitPart": 142,
              "originalCallPart": 139
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
            "nativeSession": "01a123df-0540-7073-ab0f-160863c68c25",
            "callPart": 142,
            "resultPart": 145,
            "callTimestamp": "2026-10-10T04:00:15.911+00:00",
            "responseTimestamp": "2026-10-10T04:00:31.129+00:00",
            "mechanisms": [],
            "conditionalAlternatives": false,
            "chain": {
              "cellId": "65",
              "yieldPart": 143,
              "waitPart": 144,
              "originalCallPart": 142
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
      "cold26Assessment": {
        "request_id": "35121480",
        "owner": "su-faf26552-0633-4081-a250-172c02f07c19",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a123df-0540-7073-ab0f-160863c68c25",
            "callPart": 139,
            "resultPart": 140,
            "callTimestamp": "2026-10-10T03:59:38.018+00:00",
            "responseTimestamp": "2026-10-10T04:00:09.081+00:00",
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
          }
        ],
        "acceptedPairCount": 0,
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch3-424d5.json",
        "outcomeJoined": false
      },
      "cold27Assessment": {
        "request_id": "35121480",
        "owner": "su-faf26552-0633-4081-a250-172c02f07c19",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "acceptedPairCount": 0,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a123df-0540-7073-ab0f-160863c68c25",
            "callPart": 139,
            "resultPart": 140,
            "callTimestamp": "2026-10-10T03:59:38.018+00:00",
            "responseTimestamp": "2026-10-10T04:00:09.081+00:00",
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
          }
        ],
        "outcomeJoined": false,
        "assessmentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold27-original45-lineage-augmentation-batch4-424d5.json",
        "sourceLocationAssessment": {
          "request_id": "35121480",
          "owner": "su-faf26552-0633-4081-a250-172c02f07c19",
          "ledger": {
            "id": "35121480",
            "tool_name": "session:request-compaction",
            "coord_owner_id": "su-faf26552-0633-4081-a250-172c02f07c19",
            "invoked_at": "2026-10-10 04:00:21.361+00",
            "duration_ms": 27766,
            "status": "ok",
            "args_json": {
              "focus": "Continue EI-24833086093391569 source-only unless explicit leader authorization arrives; never retry shared scheduler. Repair the existing cold loop delivery-to-turn path reported by loop:status rewakeGuaranteed:false; do not create a second loop. Resume from the current work-item checkpoint and this loop checkpoint.",
              "autoContinue": true
            }
          },
          "sourceRefs": [
            "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch3-424d5.json"
          ],
          "nativeSessions": [
            "01a123df-0540-7073-ab0f-160863c68c25"
          ],
          "originalCandidateCount": 3,
          "lineageCount": 8,
          "unofferedToolUses": [],
          "scopedLocationsMissing": true,
          "outcomeJoined": false
        }
      }
    },
    {
      "request_id": "35133707",
      "owner": "su-8d2cb6cc-8f27-4a25-8541-b00927471b94",
      "acceptedUnique": true,
      "completeOriginalPair": true,
      "receiptState": "queued",
      "pairs": [
        {
          "nativeSession": "01a123fe-6eda-7640-9dc5-7f91366ee84e",
          "callPart": 157,
          "resultPart": 158,
          "callTimestamp": "2026-10-10T04:28:03.242+00:00",
          "responseTimestamp": "2026-10-10T04:28:04.775+00:00",
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
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch3-424d5.json",
      "outcomeJoined": false,
      "assessmentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold26-native-assessment-original49-424d5.json",
      "instrumentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold26-native-analysis-instrument-424d5.json"
    },
    {
      "owner": "su-faf26552-0633-4081-a250-172c02f07c19",
      "request_id": "35145396",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a12411-e413-7d30-ae42-79e0a4cd8440",
          "callPart": 101,
          "resultPart": 102,
          "literalArgsEqual": true,
          "ledgerOwner": "su-faf26552-0633-4081-a250-172c02f07c19",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-10 04:52:19.47+00",
          "durationMs": 9345,
          "derivedDispatchStart": "2026-10-10T04:52:10.125Z",
          "callTimestamp": "2026-10-10 00:52:09.122-04",
          "responseTimestamp": "2026-10-10 00:52:23.484-04",
          "callBeforeDispatchMs": 1003,
          "responseAfterSettleMs": 4014,
          "bounds": true,
          "noAmbiguity": true,
          "error": "no-compaction-body",
          "state": "unclassified",
          "statusAgrees": false,
          "accepted": false,
          "sourceComplete": false
        }
      ],
      "rejected": [],
      "receiptState": "unresolved",
      "acceptedUnique": false,
      "reason": "no-accepted-complete-pair",
      "cold24Reassessment": {
        "owner": "su-faf26552-0633-4081-a250-172c02f07c19",
        "request_id": "35145396",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a12411-e413-7d30-ae42-79e0a4cd8440",
            "callPart": 101,
            "resultPart": 102,
            "callTimestamp": "2026-10-10T04:52:09.122+00:00",
            "responseTimestamp": "2026-10-10T04:52:23.484+00:00",
            "mechanisms": [
              "invoke"
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
      "cold25Assessment": {
        "request_id": "35145396",
        "owner": "su-faf26552-0633-4081-a250-172c02f07c19",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a12411-e413-7d30-ae42-79e0a4cd8440",
            "callPart": 101,
            "resultPart": 102,
            "callTimestamp": "2026-10-10T04:52:09.122+00:00",
            "responseTimestamp": "2026-10-10T04:52:23.484+00:00",
            "mechanisms": [
              "invoke"
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
      "cold26Assessment": {
        "request_id": "35145396",
        "owner": "su-faf26552-0633-4081-a250-172c02f07c19",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a12411-e413-7d30-ae42-79e0a4cd8440",
            "callPart": 101,
            "resultPart": 102,
            "callTimestamp": "2026-10-10T04:52:09.122+00:00",
            "responseTimestamp": "2026-10-10T04:52:23.484+00:00",
            "mechanisms": [
              "invoke"
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
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch3-424d5.json",
        "outcomeJoined": false
      },
      "cold27Assessment": {
        "request_id": "35145396",
        "owner": "su-faf26552-0633-4081-a250-172c02f07c19",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "acceptedPairCount": 0,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a12411-e413-7d30-ae42-79e0a4cd8440",
            "callPart": 96,
            "resultPart": 97,
            "callTimestamp": "2026-10-10T04:51:19.272+00:00",
            "responseTimestamp": "2026-10-10T04:51:25.834+00:00",
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
            "nativeSession": "01a12411-e413-7d30-ae42-79e0a4cd8440",
            "callPart": 99,
            "resultPart": 100,
            "callTimestamp": "2026-10-10T04:51:43.791+00:00",
            "responseTimestamp": "2026-10-10T04:52:00.072+00:00",
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
            "nativeSession": "01a12411-e413-7d30-ae42-79e0a4cd8440",
            "callPart": 101,
            "resultPart": 102,
            "callTimestamp": "2026-10-10T04:52:09.122+00:00",
            "responseTimestamp": "2026-10-10T04:52:23.484+00:00",
            "mechanisms": [
              "invoke"
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
          },
          {
            "nativeSession": "01a12411-e413-7d30-ae42-79e0a4cd8440",
            "callPart": 103,
            "resultPart": 104,
            "callTimestamp": "2026-10-10T04:53:15.548+00:00",
            "responseTimestamp": "2026-10-10T04:53:49.592+00:00",
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
        "outcomeJoined": false,
        "assessmentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold27-original45-lineage-augmentation-batch4-424d5.json",
        "sourceLocationAssessment": {
          "request_id": "35145396",
          "owner": "su-faf26552-0633-4081-a250-172c02f07c19",
          "ledger": {
            "id": "35145396",
            "tool_name": "session:request-compaction",
            "coord_owner_id": "su-faf26552-0633-4081-a250-172c02f07c19",
            "invoked_at": "2026-10-10 04:52:19.47+00",
            "duration_ms": 9345,
            "status": "ok",
            "args_json": {
              "focus": "Resume EI-24833086093391569. The source-only FreshPgDb acquisition-delay discriminator is documented in the item and loop checkpoints; explicit fleet-leader authorization to add/run it is still pending (ask thread coord-send-6344360cfabd49d66a88578376d3a15d6600526be30b8b54246ec70862dce982). Never retry the shared scheduler. A fresh loop:status read now says rewakeGuaranteed=true; the prior no-guarantee report was retracted and the leader was notified. On wake, read the leader's answer and inspect the full loop completion-proof field before making any claim about that path.",
              "autoContinue": true
            }
          },
          "sourceRefs": [
            "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch3-424d5.json"
          ],
          "nativeSessions": [
            "01a12411-e413-7d30-ae42-79e0a4cd8440"
          ],
          "originalCandidateCount": 4,
          "lineageCount": 10,
          "unofferedToolUses": [
            {
              "session_id": "01a12411-e413-7d30-ae42-79e0a4cd8440",
              "part_idx": 105,
              "tool_name": "wait",
              "chars": 56,
              "clipped": false
            }
          ],
          "scopedLocationsMissing": true,
          "outcomeJoined": false
        }
      }
    },
    {
      "owner": "su-de5729a7-76d6-4498-8766-c084b2502a21",
      "request_id": "35200300",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a12489-abcc-7ff3-b35a-a8a84157896e",
          "callPart": 95,
          "resultPart": 96,
          "literalArgsEqual": true,
          "ledgerOwner": "su-de5729a7-76d6-4498-8766-c084b2502a21",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-10 06:55:57.626+00",
          "durationMs": 860,
          "derivedDispatchStart": "2026-10-10T06:55:56.766Z",
          "callTimestamp": "2026-10-10T06:55:56.458+00:00",
          "responseTimestamp": "2026-10-10T06:55:58.1+00:00",
          "callBeforeDispatchMs": 308,
          "responseAfterSettleMs": 474,
          "bounds": true,
          "noAmbiguity": true,
          "format": "toon",
          "textBlocks": null,
          "body": {
            "ok": true,
            "requested": true,
            "respawn": "queued",
            "budgetChars": 331360,
            "firstPromptSource": "continuation-note",
            "staleCheckpoints": [],
            "openOwnerQuestion": true,
            "priorRespawn": {
              "outcome": "delivered",
              "ts": "2026-10-10T04:01:53.953Z",
              "ageMs": 10443641,
              "capMs": null
            },
            "note": "Carry-respawn QUEUED — not performed yet. The host cuts this process only once your pty goes QUIET at a clean boundary, then respawns your successor on the deterministic carry document. It re-polls for a few minutes and can terminally DROP the carry — an interactive back-and-forth, or steady output, can supersede it indefinitely. So: wrap up and go quiet now, but FLUSH durable state first (work_items:checkpoint / loop:checkpoint / facts:assert) rather than relying on the cut. If you are still here on your next turn, it did not happen — re-request at the next clean stopping point instead of waiting. ⚠ open-owner-question: 1 owner ask(s) remain OPEN in the conversation ledger at this DELIBERATE boundary. They are carried in the deterministic document; do not self-answer them after the respawn."
          },
          "state": "queued",
          "statusAgrees": true,
          "accepted": true,
          "sourceComplete": true
        }
      ],
      "rejected": [],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null
    },
    {
      "owner": "su-d88420f0-c0b4-4dc7-92c7-f60ab3ddab44",
      "request_id": "35232736",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 0,
      "pairs": [],
      "rejected": [],
      "receiptState": "unresolved",
      "acceptedUnique": false,
      "reason": "no-accepted-complete-pair",
      "cold24Reassessment": {
        "owner": "su-d88420f0-c0b4-4dc7-92c7-f60ab3ddab44",
        "request_id": "35232736",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a124bf-7bab-7351-93bf-9daa6283b81e",
            "callPart": 197,
            "resultPart": 198,
            "callTimestamp": "2026-10-10T08:14:04.231+00:00",
            "responseTimestamp": "2026-10-10T08:14:35.255+00:00",
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
            "nativeSession": "01a124bf-7bab-7351-93bf-9daa6283b81e",
            "callPart": 197,
            "resultPart": 200,
            "callTimestamp": "2026-10-10T08:14:04.231+00:00",
            "responseTimestamp": "2026-10-10T08:14:47.334+00:00",
            "mechanisms": [],
            "conditionalAlternatives": false,
            "chain": {
              "cellId": "90",
              "yieldPart": 198,
              "waitPart": 199,
              "originalCallPart": 197
            },
            "literalArgsEqual": false,
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
      "cold25Assessment": {
        "request_id": "35232736",
        "owner": "su-d88420f0-c0b4-4dc7-92c7-f60ab3ddab44",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a124bf-7bab-7351-93bf-9daa6283b81e",
            "callPart": 197,
            "resultPart": 198,
            "callTimestamp": "2026-10-10T08:14:04.231+00:00",
            "responseTimestamp": "2026-10-10T08:14:35.255+00:00",
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
            "nativeSession": "01a124bf-7bab-7351-93bf-9daa6283b81e",
            "callPart": 197,
            "resultPart": 200,
            "callTimestamp": "2026-10-10T08:14:04.231+00:00",
            "responseTimestamp": "2026-10-10T08:14:47.334+00:00",
            "mechanisms": [],
            "conditionalAlternatives": false,
            "chain": {
              "cellId": "90",
              "yieldPart": 198,
              "waitPart": 199,
              "originalCallPart": 197
            },
            "literalArgsEqual": false,
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
      "cold26Assessment": {
        "request_id": "35232736",
        "owner": "su-d88420f0-c0b4-4dc7-92c7-f60ab3ddab44",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a124bf-7bab-7351-93bf-9daa6283b81e",
            "callPart": 197,
            "resultPart": 198,
            "callTimestamp": "2026-10-10T08:14:04.231+00:00",
            "responseTimestamp": "2026-10-10T08:14:35.255+00:00",
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
            "nativeSession": "01a124bf-7bab-7351-93bf-9daa6283b81e",
            "callPart": 197,
            "resultPart": 200,
            "callTimestamp": "2026-10-10T08:14:04.231+00:00",
            "responseTimestamp": "2026-10-10T08:14:47.334+00:00",
            "mechanisms": [
              "native-wrapper"
            ],
            "conditionalAlternatives": false,
            "chain": {
              "cellId": "90",
              "links": [
                {
                  "yieldPart": 198,
                  "waitPart": 199,
                  "precedingCallPart": 197
                }
              ],
              "waitPart": 199,
              "originalCallPart": 197
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
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch3-424d5.json",
        "outcomeJoined": false
      },
      "cold27Assessment": {
        "request_id": "35232736",
        "owner": "su-d88420f0-c0b4-4dc7-92c7-f60ab3ddab44",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "acceptedPairCount": 0,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a124bf-7bab-7351-93bf-9daa6283b81e",
            "callPart": 192,
            "resultPart": 193,
            "callTimestamp": "2026-10-10T08:13:32.039+00:00",
            "responseTimestamp": "2026-10-10T08:13:33.719+00:00",
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
            "nativeSession": "01a124bf-7bab-7351-93bf-9daa6283b81e",
            "callPart": 194,
            "resultPart": 195,
            "callTimestamp": "2026-10-10T08:13:40.921+00:00",
            "responseTimestamp": "2026-10-10T08:13:42.262+00:00",
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
            "nativeSession": "01a124bf-7bab-7351-93bf-9daa6283b81e",
            "callPart": 197,
            "resultPart": 198,
            "callTimestamp": "2026-10-10T08:14:04.231+00:00",
            "responseTimestamp": "2026-10-10T08:14:35.255+00:00",
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
            "nativeSession": "01a124bf-7bab-7351-93bf-9daa6283b81e",
            "callPart": 197,
            "resultPart": 200,
            "callTimestamp": "2026-10-10T08:14:04.231+00:00",
            "responseTimestamp": "2026-10-10T08:14:47.334+00:00",
            "mechanisms": [
              "native-wrapper"
            ],
            "conditionalAlternatives": false,
            "chain": {
              "cellId": "90",
              "links": [
                {
                  "yieldPart": 198,
                  "waitPart": 199,
                  "precedingCallPart": 197
                }
              ],
              "waitPart": 199,
              "originalCallPart": 197
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
        "outcomeJoined": false,
        "assessmentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold27-original45-lineage-augmentation-batch4-424d5.json",
        "sourceLocationAssessment": {
          "request_id": "35232736",
          "owner": "su-d88420f0-c0b4-4dc7-92c7-f60ab3ddab44",
          "ledger": {
            "id": "35232736",
            "tool_name": "session:request-compaction",
            "coord_owner_id": "su-d88420f0-c0b4-4dc7-92c7-f60ab3ddab44",
            "invoked_at": "2026-10-10 08:14:45.849+00",
            "duration_ms": 38908,
            "status": "ok",
            "args_json": {
              "focus": "Continue EI-25481493419888263 from the latest loop checkpoint. First re-read invocation 33955661 metadata and resolve the mcpRequestTraceId extraction discrepancy; then search exact response provenance by run/window key 6081cfa3-7469-46b7-979c-40e7aeffeae2 and verified trace id. Preserve the boundary: mcp_tool_results has no matching row with a passed positive control, the invocation has no replay key and output_ref=null, and the scoped session_turn_parts probe returned no appDiagnostics body. Do not infer global absence; keep the exact 628-byte response unresolved until the body is recovered.",
              "autoContinue": true
            }
          },
          "sourceRefs": [
            "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch3-424d5.json"
          ],
          "nativeSessions": [
            "01a124bf-7bab-7351-93bf-9daa6283b81e"
          ],
          "originalCandidateCount": 4,
          "lineageCount": 10,
          "unofferedToolUses": [],
          "scopedLocationsMissing": true,
          "outcomeJoined": false
        }
      }
    },
    {
      "owner": "su-312c90f2-a3bd-4c92-ac4e-4eae40ae2647",
      "request_id": "35239534",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 0,
      "pairs": [],
      "rejected": [],
      "receiptState": "unresolved",
      "acceptedUnique": false,
      "reason": "no-accepted-complete-pair",
      "cold24Reassessment": {
        "owner": "su-312c90f2-a3bd-4c92-ac4e-4eae40ae2647",
        "request_id": "35239534",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a124df-4dc0-7741-97a6-73362938b29d",
            "callPart": 95,
            "resultPart": 96,
            "callTimestamp": "2026-10-10T08:27:58.704+00:00",
            "responseTimestamp": "2026-10-10T08:28:03.203+00:00",
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
            "nativeSession": "01a124df-4dc0-7741-97a6-73362938b29d",
            "callPart": 99,
            "resultPart": 100,
            "callTimestamp": "2026-10-10T08:28:41.984+00:00",
            "responseTimestamp": "2026-10-10T08:28:45.806+00:00",
            "mechanisms": [
              "ptool-quoted-json"
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
      "cold25Assessment": {
        "request_id": "35239534",
        "owner": "su-312c90f2-a3bd-4c92-ac4e-4eae40ae2647",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a124df-4dc0-7741-97a6-73362938b29d",
            "callPart": 95,
            "resultPart": 96,
            "callTimestamp": "2026-10-10T08:27:58.704+00:00",
            "responseTimestamp": "2026-10-10T08:28:03.203+00:00",
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
            "nativeSession": "01a124df-4dc0-7741-97a6-73362938b29d",
            "callPart": 99,
            "resultPart": 100,
            "callTimestamp": "2026-10-10T08:28:41.984+00:00",
            "responseTimestamp": "2026-10-10T08:28:45.806+00:00",
            "mechanisms": [
              "ptool-quoted-json"
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
      "cold26Assessment": {
        "request_id": "35239534",
        "owner": "su-312c90f2-a3bd-4c92-ac4e-4eae40ae2647",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a124df-4dc0-7741-97a6-73362938b29d",
            "callPart": 95,
            "resultPart": 96,
            "callTimestamp": "2026-10-10T08:27:58.704+00:00",
            "responseTimestamp": "2026-10-10T08:28:03.203+00:00",
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
            "nativeSession": "01a124df-4dc0-7741-97a6-73362938b29d",
            "callPart": 99,
            "resultPart": 100,
            "callTimestamp": "2026-10-10T08:28:41.984+00:00",
            "responseTimestamp": "2026-10-10T08:28:45.806+00:00",
            "mechanisms": [
              "ptool-quoted-json"
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
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch3-424d5.json",
        "outcomeJoined": false
      },
      "cold27Assessment": {
        "request_id": "35239534",
        "owner": "su-312c90f2-a3bd-4c92-ac4e-4eae40ae2647",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "acceptedPairCount": 0,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a124df-4dc0-7741-97a6-73362938b29d",
            "callPart": 95,
            "resultPart": 96,
            "callTimestamp": "2026-10-10T08:27:58.704+00:00",
            "responseTimestamp": "2026-10-10T08:28:03.203+00:00",
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
            "nativeSession": "01a124df-4dc0-7741-97a6-73362938b29d",
            "callPart": 97,
            "resultPart": 98,
            "callTimestamp": "2026-10-10T08:28:28.127+00:00",
            "responseTimestamp": "2026-10-10T08:28:28.799+00:00",
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
            "nativeSession": "01a124df-4dc0-7741-97a6-73362938b29d",
            "callPart": 99,
            "resultPart": 100,
            "callTimestamp": "2026-10-10T08:28:41.984+00:00",
            "responseTimestamp": "2026-10-10T08:28:45.806+00:00",
            "mechanisms": [
              "ptool-quoted-json"
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
        "outcomeJoined": false,
        "assessmentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold27-original45-lineage-augmentation-batch4-424d5.json",
        "sourceLocationAssessment": {
          "request_id": "35239534",
          "owner": "su-312c90f2-a3bd-4c92-ac4e-4eae40ae2647",
          "ledger": {
            "id": "35239534",
            "tool_name": "session:request-compaction",
            "coord_owner_id": "su-312c90f2-a3bd-4c92-ac4e-4eae40ae2647",
            "invoked_at": "2026-10-10 08:28:44.194+00",
            "duration_ms": 784,
            "status": "ok",
            "args_json": {
              "focus": "Continue EI-25574253034038454. Re-orient; read the current item and checkpoint. The report remains unverified: source/schema accept testClass and the handler adds currentBuildTestRoute at top level. Reporter su-c4dc38e8-5f3c-48fc-a4ad-3efd0ad46078 was asked for the complete result (message coord-send-7d4e94b6d4fb929f5375f98cd574504172e8e9a326b24936d40c948a4200c7df; woken=1, pickup unconfirmed). Gate ownership is held-live by su-88909c8d-d46f-4a5d-9473-d0220bf07af2; do not call dev:pipeline_position or read gate status again. Continue the fleet scheduler lane after resolving this item.",
              "autoContinue": true
            }
          },
          "sourceRefs": [
            "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch3-424d5.json"
          ],
          "nativeSessions": [
            "01a124df-4dc0-7741-97a6-73362938b29d"
          ],
          "originalCandidateCount": 3,
          "lineageCount": 7,
          "unofferedToolUses": [],
          "scopedLocationsMissing": true,
          "outcomeJoined": false
        }
      }
    },
    {
      "owner": "su-1415d088-0af5-4299-a5df-8dbfc634335b",
      "request_id": "35246962",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 0,
      "pairs": [
        {
          "nativeSession": "01a124e2-3f90-7a21-911a-e231ad19ebf7",
          "callPart": 129,
          "resultPart": 132,
          "callTimestamp": "2026-10-10 08:45:33.78+00",
          "responseTimestamp": "2026-10-10 04:46:39.372-04",
          "mechanisms": [
            "native-wrapper"
          ],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "53",
            "yieldPart": 130,
            "waitPart": 131,
            "originalCallPart": 129
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
          "completeOriginalPair": true,
          "accepted": true,
          "state": "queued"
        }
      ],
      "rejected": [],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null,
      "priorAssessment": {
        "owner": "su-1415d088-0af5-4299-a5df-8dbfc634335b",
        "request_id": "35246962",
        "ledgerStatus": "ok",
        "candidates": 1,
        "exactArgumentMatches": 0,
        "pairs": [],
        "rejected": [],
        "receiptState": "unresolved",
        "acceptedUnique": false,
        "reason": "no-accepted-complete-pair"
      },
      "custodySource": "audits/parked-agent-resumption-2026-10-09/r13-cold23-remaining-wait-assessment-424d5.json",
      "currentSourceAssessment": {
        "request_id": "35246962",
        "owner": "su-1415d088-0af5-4299-a5df-8dbfc634335b",
        "completeOriginalPair": true,
        "pairs": [
          {
            "nativeSession": "01a124e2-3f90-7a21-911a-e231ad19ebf7",
            "callPart": 129,
            "resultPart": 132,
            "callTimestamp": "2026-10-10 08:45:33.78+00",
            "responseTimestamp": "2026-10-10 04:46:39.372-04",
            "mechanisms": [
              "native-wrapper"
            ],
            "conditionalAlternatives": false,
            "chain": {
              "cellId": "53",
              "yieldPart": 130,
              "waitPart": 131,
              "originalCallPart": 129
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
      }
    },
    {
      "owner": "su-1415d088-0af5-4299-a5df-8dbfc634335b",
      "request_id": "35257928",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 1,
      "pairs": [
        {
          "nativeSession": "01a124fe-a7f4-7400-82a0-711981ff4174",
          "callPart": 128,
          "resultPart": 129,
          "literalArgsEqual": true,
          "ledgerOwner": "su-1415d088-0af5-4299-a5df-8dbfc634335b",
          "ownerEqual": true,
          "ledgerSettle": "2026-10-10 09:09:15.586+00",
          "durationMs": 11235,
          "derivedDispatchStart": "2026-10-10T09:09:04.351Z",
          "callTimestamp": "2026-10-10 05:09:03.805-04",
          "responseTimestamp": "2026-10-10 05:09:24.508-04",
          "callBeforeDispatchMs": 546,
          "responseAfterSettleMs": 8922,
          "bounds": true,
          "noAmbiguity": true,
          "format": "toon",
          "textBlocks": 2,
          "body": {
            "ok": true,
            "requested": true,
            "respawn": "queued",
            "budgetChars": 331360,
            "firstPromptSource": "continuation-note",
            "staleCheckpoints": [],
            "openOwnerQuestion": false,
            "priorRespawn": {
              "outcome": "delivered",
              "ts": "2026-10-10T08:47:54.946Z",
              "ageMs": 1277311,
              "capMs": null
            },
            "note": "Carry-respawn QUEUED — not performed yet. The host cuts this process only once your pty goes QUIET at a clean boundary, then respawns your successor on the deterministic carry document. It re-polls for a few minutes and can terminally DROP the carry — an interactive back-and-forth, or steady output, can supersede it indefinitely. So: wrap up and go quiet now, but FLUSH durable state first (work_items:checkpoint / loop:checkpoint / facts:assert) rather than relying on the cut. If you are still here on your next turn, it did not happen — re-request at the next clean stopping point instead of waiting."
          },
          "state": "queued",
          "statusAgrees": true,
          "accepted": true,
          "sourceComplete": true
        }
      ],
      "rejected": [],
      "receiptState": "queued",
      "acceptedUnique": true,
      "reason": null
    },
    {
      "owner": "su-1415d088-0af5-4299-a5df-8dbfc634335b",
      "request_id": "35268060",
      "ledgerStatus": "ok",
      "candidates": 0,
      "exactArgumentMatches": 0,
      "pairs": [],
      "rejected": [],
      "receiptState": "unresolved",
      "acceptedUnique": false,
      "reason": "no-accepted-complete-pair",
      "cold24Reassessment": {
        "owner": "su-1415d088-0af5-4299-a5df-8dbfc634335b",
        "request_id": "35268060",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a12513-3862-7261-ae4a-79265df0b73a",
            "callPart": 135,
            "resultPart": 136,
            "callTimestamp": "2026-10-10T09:34:49.928+00:00",
            "responseTimestamp": "2026-10-10T09:35:13.452+00:00",
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
      "cold25Assessment": {
        "request_id": "35268060",
        "owner": "su-1415d088-0af5-4299-a5df-8dbfc634335b",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a12513-3862-7261-ae4a-79265df0b73a",
            "callPart": 135,
            "resultPart": 136,
            "callTimestamp": "2026-10-10T09:34:49.928+00:00",
            "responseTimestamp": "2026-10-10T09:35:13.452+00:00",
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
      "cold26Assessment": {
        "request_id": "35268060",
        "owner": "su-1415d088-0af5-4299-a5df-8dbfc634335b",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a12513-3862-7261-ae4a-79265df0b73a",
            "callPart": 135,
            "resultPart": 136,
            "callTimestamp": "2026-10-10T09:34:49.928+00:00",
            "responseTimestamp": "2026-10-10T09:35:13.452+00:00",
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
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch3-424d5.json",
        "outcomeJoined": false
      },
      "cold27Assessment": {
        "request_id": "35268060",
        "owner": "su-1415d088-0af5-4299-a5df-8dbfc634335b",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "acceptedPairCount": 0,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a12513-3862-7261-ae4a-79265df0b73a",
            "callPart": 135,
            "resultPart": 136,
            "callTimestamp": "2026-10-10T09:34:49.928+00:00",
            "responseTimestamp": "2026-10-10T09:35:13.452+00:00",
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
        "outcomeJoined": false,
        "assessmentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold27-original45-lineage-augmentation-batch4-424d5.json",
        "sourceLocationAssessment": {
          "request_id": "35268060",
          "owner": "su-1415d088-0af5-4299-a5df-8dbfc634335b",
          "ledger": {
            "id": "35268060",
            "tool_name": "session:request-compaction",
            "coord_owner_id": "su-1415d088-0af5-4299-a5df-8dbfc634335b",
            "invoked_at": "2026-10-10 09:35:13.222+00",
            "duration_ms": 4544,
            "status": "ok",
            "args_json": {
              "focus": "Resume the nonp2p bug-drain fleet-member lane. PUI EI-25529817219750684: capacity measured serviceable=1/10, but two focused test invocations failed before native launch (shared PG storage low; then missing PUI_BIN). One native attempt remains; refresh capacity, obtain candidate archive and current PUI_NATIVE_ACCOUNT_CATALOG, then use apps/tui/scripts/release-acceptance.sh with the exact test filter. S38 EI-25395605811228800: last tree read HEAD 817d7dc3 with 36 dirty paths and no leader ruling through 09:12Z; keep gated on clean stable tree + exclusive git-sync lock + leader scope ruling. EI-25248675192543911 checkpoint attested unchanged.",
              "autoContinue": true
            }
          },
          "sourceRefs": [
            "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch3-424d5.json"
          ],
          "nativeSessions": [
            "01a12513-3862-7261-ae4a-79265df0b73a"
          ],
          "originalCandidateCount": 1,
          "lineageCount": 3,
          "unofferedToolUses": [],
          "scopedLocationsMissing": true,
          "outcomeJoined": false
        }
      }
    },
    {
      "owner": "su-4adf5ebc-6443-4c3c-b704-162275765ff1",
      "request_id": "35277559",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 0,
      "pairs": [],
      "rejected": [],
      "receiptState": "unresolved",
      "acceptedUnique": false,
      "reason": "no-accepted-complete-pair",
      "cold24Reassessment": {
        "owner": "su-4adf5ebc-6443-4c3c-b704-162275765ff1",
        "request_id": "35277559",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [],
        "acceptedPairCount": 0,
        "outcomeJoined": false
      },
      "cold25Assessment": {
        "request_id": "35277559",
        "owner": "su-4adf5ebc-6443-4c3c-b704-162275765ff1",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [],
        "acceptedPairCount": 0,
        "outcomeJoined": false
      },
      "cold26Assessment": {
        "request_id": "35277559",
        "owner": "su-4adf5ebc-6443-4c3c-b704-162275765ff1",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [],
        "acceptedPairCount": 0,
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch3-424d5.json",
        "outcomeJoined": false
      },
      "cold27Assessment": {
        "request_id": "35277559",
        "owner": "su-4adf5ebc-6443-4c3c-b704-162275765ff1",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "acceptedPairCount": 0,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a1252d-875a-7600-b7c0-29f98f6791f2",
            "callPart": 153,
            "resultPart": 154,
            "callTimestamp": "2026-10-10T09:57:29.68+00:00",
            "responseTimestamp": "2026-10-10T09:57:48.948+00:00",
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
            "nativeSession": "01a1252d-875a-7600-b7c0-29f98f6791f2",
            "callPart": 155,
            "resultPart": 156,
            "callTimestamp": "2026-10-10T09:58:00.201+00:00",
            "responseTimestamp": "2026-10-10T09:58:00.914+00:00",
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
            "nativeSession": "01a1252d-875a-7600-b7c0-29f98f6791f2",
            "callPart": 158,
            "resultPart": 159,
            "callTimestamp": "2026-10-10T09:58:12.938+00:00",
            "responseTimestamp": "2026-10-10T09:58:13.987+00:00",
            "mechanisms": [],
            "conditionalAlternatives": false,
            "chain": null,
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
          },
          {
            "nativeSession": "01a1253f-e361-75a0-a286-aeb68a8fb97d",
            "callPart": 4,
            "resultPart": 5,
            "callTimestamp": "2026-10-10T09:59:04.456+00:00",
            "responseTimestamp": "2026-10-10T09:59:14.787+00:00",
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
          }
        ],
        "outcomeJoined": false,
        "assessmentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold27-original45-lineage-augmentation-batch4-424d5.json",
        "sourceLocationAssessment": {
          "request_id": "35277559",
          "owner": "su-4adf5ebc-6443-4c3c-b704-162275765ff1",
          "ledger": {
            "id": "35277559",
            "tool_name": "session:request-compaction",
            "coord_owner_id": "su-4adf5ebc-6443-4c3c-b704-162275765ff1",
            "invoked_at": "2026-10-10 09:58:13.763+00",
            "duration_ms": 622,
            "status": "ok",
            "args_json": {
              "focus": "Continue only WI-10007687 and EI-25430021485502676. Identity verified as su-4adf5ebc-6443-4c3c-b704-162275765ff1; recovery marker/control hash matched, so do not re-orient. Cold work loop is armed at 60s for WI-10007687 and loop:status verified rewakeGuaranteed=true. Both items remain assigned and blocked; keep them open, no scope change. A new bulk review on EI was answered KEEP/INVESTIGATE with evidence. Tests: capture.test.ts 182/182 (clean HEAD bd1605236e; no explicit harness scope); capture-core.test.ts 231/231 with PAPERCUSP_TEST_RUN_HARNESS=papercusp at the same HEAD. Current staging timing log at 2026-10-10 09:46:27Z: totalElapsedMs 1465.1; core.captureImprovement/wrapper.persist 855.7ms; metadata.toolFailureStaleness 606.9ms; two lookup stages 447.7+370.8ms. A staging journal query since the timing-recorder commit (2026-10-09 06:20 local) found 0 timing entries >=40s, matched=0, not truncated. This does not attribute the historical 48.45558s handler call: original args and phase log remain unavailable. Next: investigate whether the 09:46 timing trace id 00e2dc3f is the same request as adjacent mcp-request-trace f7bd726a or a concurrent call; confirm from source/ledger before changing instrumentation. Then seek an exact same-branch write trace or historical invocation evidence. Do not infer from check-only runs or create work outside these two items. Event key is the unprefixed fleet:nonp2p-bug-drain-luna-max-0930:papercusp:shared-headroom-recovered; latest checked generation 3 remains declared with su-98a6938f as live leader successor. Await 262083 timed out at 09:46:24Z; no replacement is registered. Leader retracted their prefixed-key error and is refreshing receipts; do not duplicate those live reads. Existing owner-scope conversation answer await 260494 remains active. work_items:comment contains the full evidence and corrections; work_items:checkpoint narrative saved this turn but check-row merge was refused due row cap, so do not claim new rows persisted.",
              "autoContinue": true
            }
          },
          "sourceRefs": [
            "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch3-424d5.json"
          ],
          "nativeSessions": [
            "01a1252d-875a-7600-b7c0-29f98f6791f2",
            "01a1253f-e361-75a0-a286-aeb68a8fb97d"
          ],
          "originalCandidateCount": 4,
          "lineageCount": 11,
          "unofferedToolUses": [
            {
              "session_id": "01a1253f-e361-75a0-a286-aeb68a8fb97d",
              "part_idx": 6,
              "tool_name": "exec",
              "chars": 558,
              "clipped": false
            }
          ],
          "scopedLocationsMissing": true,
          "outcomeJoined": false
        }
      }
    },
    {
      "owner": "su-4adf5ebc-6443-4c3c-b704-162275765ff1",
      "request_id": "35286001",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 0,
      "pairs": [],
      "rejected": [],
      "receiptState": "unresolved",
      "acceptedUnique": false,
      "reason": "no-accepted-complete-pair",
      "cold24Reassessment": {
        "owner": "su-4adf5ebc-6443-4c3c-b704-162275765ff1",
        "request_id": "35286001",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a1253f-e361-75a0-a286-aeb68a8fb97d",
            "callPart": 146,
            "resultPart": 147,
            "callTimestamp": "2026-10-10T10:15:55.774+00:00",
            "responseTimestamp": "2026-10-10T10:16:00.424+00:00",
            "mechanisms": [],
            "conditionalAlternatives": false,
            "chain": null,
            "literalArgsEqual": false,
            "ownerEqual": true,
            "bounds": true,
            "sourceComplete": false,
            "parseErrors": 5,
            "receiptState": "unclassified",
            "statusAgrees": false,
            "completeOriginalPair": false
          }
        ],
        "acceptedPairCount": 0,
        "outcomeJoined": false
      },
      "cold25Assessment": {
        "request_id": "35286001",
        "owner": "su-4adf5ebc-6443-4c3c-b704-162275765ff1",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a1253f-e361-75a0-a286-aeb68a8fb97d",
            "callPart": 146,
            "resultPart": 147,
            "callTimestamp": "2026-10-10T10:15:55.774+00:00",
            "responseTimestamp": "2026-10-10T10:16:00.424+00:00",
            "mechanisms": [],
            "conditionalAlternatives": false,
            "chain": null,
            "literalArgsEqual": false,
            "ownerEqual": true,
            "bounds": true,
            "sourceComplete": false,
            "parseErrors": 5,
            "receiptState": "unclassified",
            "statusAgrees": false,
            "completeOriginalPair": false
          }
        ],
        "acceptedPairCount": 0,
        "outcomeJoined": false
      },
      "cold26Assessment": {
        "request_id": "35286001",
        "owner": "su-4adf5ebc-6443-4c3c-b704-162275765ff1",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a1253f-e361-75a0-a286-aeb68a8fb97d",
            "callPart": 146,
            "resultPart": 147,
            "callTimestamp": "2026-10-10T10:15:55.774+00:00",
            "responseTimestamp": "2026-10-10T10:16:00.424+00:00",
            "mechanisms": [],
            "conditionalAlternatives": false,
            "chain": null,
            "literalArgsEqual": false,
            "ownerEqual": true,
            "bounds": true,
            "sourceComplete": false,
            "parseErrors": 5,
            "receiptState": "unclassified",
            "statusAgrees": false,
            "completeOriginalPair": false
          }
        ],
        "acceptedPairCount": 0,
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch3-424d5.json",
        "outcomeJoined": false
      },
      "cold27Assessment": {
        "request_id": "35286001",
        "owner": "su-4adf5ebc-6443-4c3c-b704-162275765ff1",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "acceptedPairCount": 0,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a1253f-e361-75a0-a286-aeb68a8fb97d",
            "callPart": 144,
            "resultPart": 145,
            "callTimestamp": "2026-10-10T10:15:10.139+00:00",
            "responseTimestamp": "2026-10-10T10:15:12.893+00:00",
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
            "nativeSession": "01a1253f-e361-75a0-a286-aeb68a8fb97d",
            "callPart": 146,
            "resultPart": 147,
            "callTimestamp": "2026-10-10T10:15:55.774+00:00",
            "responseTimestamp": "2026-10-10T10:16:00.424+00:00",
            "mechanisms": [],
            "conditionalAlternatives": false,
            "chain": null,
            "literalArgsEqual": false,
            "ownerEqual": true,
            "bounds": true,
            "sourceComplete": false,
            "parseErrors": 5,
            "receiptState": "unclassified",
            "statusAgrees": false,
            "completeOriginalPair": false
          }
        ],
        "outcomeJoined": false,
        "assessmentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold27-original45-lineage-augmentation-batch4-424d5.json",
        "sourceLocationAssessment": {
          "request_id": "35286001",
          "owner": "su-4adf5ebc-6443-4c3c-b704-162275765ff1",
          "ledger": {
            "id": "35286001",
            "tool_name": "session:request-compaction",
            "coord_owner_id": "su-4adf5ebc-6443-4c3c-b704-162275765ff1",
            "invoked_at": "2026-10-10 10:15:59.881+00",
            "duration_ms": 613,
            "status": "ok",
            "args_json": {
              "focus": "Continue only WI-10007687 and EI-25430021485502676. Use updated item checkpoints/comments: original args for invocation row 34073478 are recovered; dispatch invoke=48,455.58ms; handler cause remains unknown. Preserve blocked status and existing Avi scope conversation; refresh leader headroom evidence before any scope/code change. Do not attribute current staging timing to the historical request.",
              "autoContinue": true
            }
          },
          "sourceRefs": [
            "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch3-424d5.json"
          ],
          "nativeSessions": [
            "01a1253f-e361-75a0-a286-aeb68a8fb97d"
          ],
          "originalCandidateCount": 2,
          "lineageCount": 5,
          "unofferedToolUses": [],
          "scopedLocationsMissing": true,
          "outcomeJoined": false
        }
      }
    },
    {
      "request_id": "35289337",
      "owner": "su-d88420f0-c0b4-4dc7-92c7-f60ab3ddab44",
      "acceptedUnique": true,
      "completeOriginalPair": true,
      "receiptState": "queued",
      "pairs": [
        {
          "nativeSession": "01a12531-ca04-75f2-a94c-e14631082377",
          "callPart": 166,
          "resultPart": 167,
          "callTimestamp": "2026-10-10T10:23:12.583+00:00",
          "responseTimestamp": "2026-10-10T10:23:43.677+00:00",
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
          "nativeSession": "01a12531-ca04-75f2-a94c-e14631082377",
          "callPart": 166,
          "resultPart": 169,
          "callTimestamp": "2026-10-10T10:23:12.583+00:00",
          "responseTimestamp": "2026-10-10T10:23:57.489+00:00",
          "mechanisms": [
            "native-wrapper"
          ],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "65",
            "yieldPart": 167,
            "waitPart": 168,
            "originalCallPart": 166
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
      "outcomeJoined": false,
      "assessmentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch3-424d5.json",
      "instrumentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold25-native-analysis-instrument-424d5.json"
    },
    {
      "owner": "su-1415d088-0af5-4299-a5df-8dbfc634335b",
      "request_id": "35305755",
      "ledgerStatus": "ok",
      "candidates": 0,
      "exactArgumentMatches": 0,
      "pairs": [],
      "rejected": [],
      "receiptState": "unresolved",
      "acceptedUnique": false,
      "reason": "no-accepted-complete-pair",
      "cold24Reassessment": {
        "owner": "su-1415d088-0af5-4299-a5df-8dbfc634335b",
        "request_id": "35305755",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a1254c-cc9a-75c0-9c26-f5e67d2b79a3",
            "callPart": 266,
            "resultPart": 267,
            "callTimestamp": "2026-10-10T11:04:11.563+00:00",
            "responseTimestamp": "2026-10-10T11:04:15.94+00:00",
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
            "nativeSession": "01a1254c-cc9a-75c0-9c26-f5e67d2b79a3",
            "callPart": 270,
            "resultPart": 271,
            "callTimestamp": "2026-10-10T11:04:47.029+00:00",
            "responseTimestamp": "2026-10-10T11:05:05.947+00:00",
            "mechanisms": [],
            "conditionalAlternatives": false,
            "chain": null,
            "literalArgsEqual": false,
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
      "cold25Assessment": {
        "request_id": "35305755",
        "owner": "su-1415d088-0af5-4299-a5df-8dbfc634335b",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a1254c-cc9a-75c0-9c26-f5e67d2b79a3",
            "callPart": 266,
            "resultPart": 267,
            "callTimestamp": "2026-10-10T11:04:11.563+00:00",
            "responseTimestamp": "2026-10-10T11:04:15.94+00:00",
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
            "nativeSession": "01a1254c-cc9a-75c0-9c26-f5e67d2b79a3",
            "callPart": 270,
            "resultPart": 271,
            "callTimestamp": "2026-10-10T11:04:47.029+00:00",
            "responseTimestamp": "2026-10-10T11:05:05.947+00:00",
            "mechanisms": [
              "ptool-invoke-quoted-json"
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
      "cold26Assessment": {
        "request_id": "35305755",
        "owner": "su-1415d088-0af5-4299-a5df-8dbfc634335b",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a1254c-cc9a-75c0-9c26-f5e67d2b79a3",
            "callPart": 266,
            "resultPart": 267,
            "callTimestamp": "2026-10-10T11:04:11.563+00:00",
            "responseTimestamp": "2026-10-10T11:04:15.94+00:00",
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
            "nativeSession": "01a1254c-cc9a-75c0-9c26-f5e67d2b79a3",
            "callPart": 270,
            "resultPart": 271,
            "callTimestamp": "2026-10-10T11:04:47.029+00:00",
            "responseTimestamp": "2026-10-10T11:05:05.947+00:00",
            "mechanisms": [
              "ptool-invoke-quoted-json"
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
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch3-424d5.json",
        "outcomeJoined": false
      },
      "cold27Assessment": {
        "request_id": "35305755",
        "owner": "su-1415d088-0af5-4299-a5df-8dbfc634335b",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "acceptedPairCount": 0,
        "receiptState": "unresolved",
        "pairs": [
          {
            "nativeSession": "01a1254c-cc9a-75c0-9c26-f5e67d2b79a3",
            "callPart": 266,
            "resultPart": 267,
            "callTimestamp": "2026-10-10T11:04:11.563+00:00",
            "responseTimestamp": "2026-10-10T11:04:15.94+00:00",
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
            "nativeSession": "01a1254c-cc9a-75c0-9c26-f5e67d2b79a3",
            "callPart": 268,
            "resultPart": 269,
            "callTimestamp": "2026-10-10T11:04:29.12+00:00",
            "responseTimestamp": "2026-10-10T11:04:40.946+00:00",
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
            "nativeSession": "01a1254c-cc9a-75c0-9c26-f5e67d2b79a3",
            "callPart": 270,
            "resultPart": 271,
            "callTimestamp": "2026-10-10T11:04:47.029+00:00",
            "responseTimestamp": "2026-10-10T11:05:05.947+00:00",
            "mechanisms": [
              "ptool-invoke-quoted-json"
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
          },
          {
            "nativeSession": "01a1257d-6598-73a3-97b9-bbaf7f11c96f",
            "callPart": 4,
            "resultPart": 5,
            "callTimestamp": "2026-10-10T11:05:50.795+00:00",
            "responseTimestamp": "2026-10-10T11:05:50.877+00:00",
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
            "nativeSession": "01a1257d-6598-73a3-97b9-bbaf7f11c96f",
            "callPart": 6,
            "resultPart": 7,
            "callTimestamp": "2026-10-10T11:05:54.367+00:00",
            "responseTimestamp": "2026-10-10T11:06:07.837+00:00",
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
          }
        ],
        "outcomeJoined": false,
        "assessmentRef": "audits/parked-agent-resumption-2026-10-09/r13-cold27-original45-lineage-augmentation-batch4-424d5.json",
        "sourceLocationAssessment": {
          "request_id": "35305755",
          "owner": "su-1415d088-0af5-4299-a5df-8dbfc634335b",
          "ledger": {
            "id": "35305755",
            "tool_name": "session:request-compaction",
            "coord_owner_id": "su-1415d088-0af5-4299-a5df-8dbfc634335b",
            "invoked_at": "2026-10-10 11:04:58.432+00",
            "duration_ms": 4721,
            "status": "ok",
            "args_json": {
              "focus": "Resume EI-25529817219750684. The symlink-slot wrapper fix and 15/15 regression pass are recorded. One supported PUI acceptance attempt failed before launch due disk-headroom preflight; the old idle physical cache slot's dependencies were safely retired under lock, recovering space. Verify fresh catalog, current Claude probe + fleet capacity, and >=47.7 GB free, then make the single allowed installed-PUI attempt with the saved archive/filter/account-auto catalog. Do not retry provider refusal. Keep S38 gates and EI-25248675192543911 leadership boundary intact; use loop:checkpoint carry note for remaining items."
            }
          },
          "sourceRefs": [
            "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch3-424d5.json"
          ],
          "nativeSessions": [
            "01a1254c-cc9a-75c0-9c26-f5e67d2b79a3",
            "01a1257d-6598-73a3-97b9-bbaf7f11c96f"
          ],
          "originalCandidateCount": 5,
          "lineageCount": 12,
          "unofferedToolUses": [
            {
              "session_id": "01a1257d-6598-73a3-97b9-bbaf7f11c96f",
              "part_idx": 8,
              "tool_name": "exec",
              "chars": 341,
              "clipped": false
            }
          ],
          "scopedLocationsMissing": true,
          "outcomeJoined": false
        }
      }
    }
  ],
  "prior92PreservedExactly": true,
  "limits": [
    "Original137 denominator and prior88 JSON records unchanged.",
    "Completeness,owner,args,native-session,status and original timestamp bounds remain required.",
    "Receipt custody is not process delivery,continuity,eligibility or recovery; refusals remain failures."
  ]
}
