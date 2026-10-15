---
rel_path: "audits/parked-agent-resumption-2026-10-09/r13-cold26-original137-custody-assessment-424d5.json"
updated_at: 1791896929002
_body: "content"
---

{
  "schemaVersion": "cold26-original137-combined-custody-v1",
  "observedAt": "2026-10-13T13:07:05.673Z",
  "cutoff": "2026-10-10T16:00:36.515Z",
  "cohortHash": "24ff6981fd54f120f96381dd93732ec9c1bfb2101d7eec063119bf85caeb163a",
  "sourceRefs": [
    "audits/parked-agent-resumption-2026-10-09/r13-cold25-original137-custody-assessment-424d5.json",
    "audits/parked-agent-resumption-2026-10-09/r13-cold26-native-assessment-original49-424d5.json",
    "audits/parked-agent-resumption-2026-10-09/r13-cold26-native-analysis-instrument-424d5.json"
  ],
  "readback": [
    {
      "path": "audits/parked-agent-resumption-2026-10-09/r13-cold25-original137-custody-assessment-424d5.json",
      "sha256": "0fbc6a2fa8422a71d17b1ae970565d7e17677115636e0bf3dabe7247add8d411",
      "exactFullReadback": true
    }
  ],
  "summary": {
    "population": 137,
    "prior88Immutable": 88,
    "newComplete": 4,
    "custodyComplete": 92,
    "queued": 90,
    "flushRefused": 1,
    "noHostRefused": 1,
    "unresolved": 45,
    "nativePairCollisions": 0,
    "nativeExecutions": 39,
    "timeouts": 0,
    "failedExecutions": 0,
    "outcomesJoined": 0,
    "cutoffContinuityAccepted": 0,
    "eligibilityAccepted": 0
  },
  "newIds": [
    "35020841",
    "35063976",
    "35064368",
    "35133707"
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
      "owner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
      "request_id": "32231391",
      "ledgerStatus": "ok",
      "candidates": 1,
      "exactArgumentMatches": 0,
      "pairs": [],
      "rejected": [],
      "receiptState": "unresolved",
      "acceptedUnique": false,
      "reason": "no-accepted-complete-pair",
      "cold24Reassessment": {
        "owner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
        "request_id": "32231391",
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
      "cold25Assessment": {
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
      "cold26Assessment": {
        "request_id": "32231391",
        "owner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
        "acceptedUnique": false,
        "completeOriginalPair": false,
        "receiptState": "unresolved",
        "pairs": [],
        "acceptedPairCount": 0,
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch1-424d5.json",
        "outcomeJoined": false
      }
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
      }
    }
  ],
  "unresolvedSourceClassification": [
    {
      "id": "32231391",
      "owner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
      "pairs": 0,
      "parseErrors": false,
      "literalArgsMatch": false,
      "completeSource": false,
      "knownReceipt": false,
      "goodOwnerBounds": false
    },
    {
      "id": "32243511",
      "owner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
      "pairs": 1,
      "parseErrors": false,
      "literalArgsMatch": true,
      "completeSource": false,
      "knownReceipt": false,
      "goodOwnerBounds": true
    },
    {
      "id": "34831365",
      "owner": "su-ab8cc07f-e903-4467-ac45-a32149258170",
      "pairs": 0,
      "parseErrors": false,
      "literalArgsMatch": false,
      "completeSource": false,
      "knownReceipt": false,
      "goodOwnerBounds": false
    },
    {
      "id": "34840615",
      "owner": "su-ab8cc07f-e903-4467-ac45-a32149258170",
      "pairs": 2,
      "parseErrors": true,
      "literalArgsMatch": false,
      "completeSource": true,
      "knownReceipt": false,
      "goodOwnerBounds": true
    },
    {
      "id": "34863926",
      "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
      "pairs": 1,
      "parseErrors": false,
      "literalArgsMatch": true,
      "completeSource": false,
      "knownReceipt": false,
      "goodOwnerBounds": true
    },
    {
      "id": "34866872",
      "owner": "su-ab8cc07f-e903-4467-ac45-a32149258170",
      "pairs": 1,
      "parseErrors": true,
      "literalArgsMatch": false,
      "completeSource": false,
      "knownReceipt": true,
      "goodOwnerBounds": true
    },
    {
      "id": "34887447",
      "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
      "pairs": 1,
      "parseErrors": false,
      "literalArgsMatch": true,
      "completeSource": false,
      "knownReceipt": false,
      "goodOwnerBounds": true
    },
    {
      "id": "34888135",
      "owner": "su-ab8cc07f-e903-4467-ac45-a32149258170",
      "pairs": 0,
      "parseErrors": false,
      "literalArgsMatch": false,
      "completeSource": false,
      "knownReceipt": false,
      "goodOwnerBounds": false
    },
    {
      "id": "34912704",
      "owner": "su-ba80f2f7-46f6-4aec-b99a-21e02460933f",
      "pairs": 4,
      "parseErrors": true,
      "literalArgsMatch": false,
      "completeSource": true,
      "knownReceipt": false,
      "goodOwnerBounds": true
    },
    {
      "id": "34938104",
      "owner": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
      "pairs": 2,
      "parseErrors": false,
      "literalArgsMatch": true,
      "completeSource": true,
      "knownReceipt": false,
      "goodOwnerBounds": true
    },
    {
      "id": "34967591",
      "owner": "su-82c46308-5eb9-4237-9d2d-950d322576c4",
      "pairs": 1,
      "parseErrors": false,
      "literalArgsMatch": true,
      "completeSource": false,
      "knownReceipt": false,
      "goodOwnerBounds": true
    },
    {
      "id": "34967597",
      "owner": "su-ddb4cbf4-2581-4f7c-8d6a-efbb712bd295",
      "pairs": 0,
      "parseErrors": false,
      "literalArgsMatch": false,
      "completeSource": false,
      "knownReceipt": false,
      "goodOwnerBounds": false
    },
    {
      "id": "34979247",
      "owner": "su-82c46308-5eb9-4237-9d2d-950d322576c4",
      "pairs": 1,
      "parseErrors": true,
      "literalArgsMatch": false,
      "completeSource": false,
      "knownReceipt": false,
      "goodOwnerBounds": true
    },
    {
      "id": "34980575",
      "owner": "su-ba80f2f7-46f6-4aec-b99a-21e02460933f",
      "pairs": 2,
      "parseErrors": false,
      "literalArgsMatch": true,
      "completeSource": false,
      "knownReceipt": false,
      "goodOwnerBounds": true
    },
    {
      "id": "34993138",
      "owner": "su-ba80f2f7-46f6-4aec-b99a-21e02460933f",
      "pairs": 1,
      "parseErrors": true,
      "literalArgsMatch": false,
      "completeSource": false,
      "knownReceipt": false,
      "goodOwnerBounds": true
    },
    {
      "id": "34995559",
      "owner": "su-ddb4cbf4-2581-4f7c-8d6a-efbb712bd295",
      "pairs": 0,
      "parseErrors": false,
      "literalArgsMatch": false,
      "completeSource": false,
      "knownReceipt": false,
      "goodOwnerBounds": false
    },
    {
      "id": "35002236",
      "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
      "pairs": 0,
      "parseErrors": false,
      "literalArgsMatch": false,
      "completeSource": false,
      "knownReceipt": false,
      "goodOwnerBounds": false
    },
    {
      "id": "35007728",
      "owner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
      "pairs": 0,
      "parseErrors": false,
      "literalArgsMatch": false,
      "completeSource": false,
      "knownReceipt": false,
      "goodOwnerBounds": false
    },
    {
      "id": "35012964",
      "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
      "pairs": 1,
      "parseErrors": true,
      "literalArgsMatch": false,
      "completeSource": false,
      "knownReceipt": false,
      "goodOwnerBounds": false
    },
    {
      "id": "35013188",
      "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
      "pairs": 1,
      "parseErrors": true,
      "literalArgsMatch": false,
      "completeSource": false,
      "knownReceipt": false,
      "goodOwnerBounds": false
    },
    {
      "id": "35013284",
      "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
      "pairs": 1,
      "parseErrors": true,
      "literalArgsMatch": true,
      "completeSource": false,
      "knownReceipt": false,
      "goodOwnerBounds": true
    },
    {
      "id": "35014709",
      "owner": "su-960a52e7-9b11-42ac-8fe9-7e5e7e0da441",
      "pairs": 1,
      "parseErrors": false,
      "literalArgsMatch": true,
      "completeSource": false,
      "knownReceipt": false,
      "goodOwnerBounds": true
    },
    {
      "id": "35015047",
      "owner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
      "pairs": 1,
      "parseErrors": false,
      "literalArgsMatch": true,
      "completeSource": false,
      "knownReceipt": false,
      "goodOwnerBounds": true
    },
    {
      "id": "35018210",
      "owner": "su-82c46308-5eb9-4237-9d2d-950d322576c4",
      "pairs": 1,
      "parseErrors": true,
      "literalArgsMatch": false,
      "completeSource": false,
      "knownReceipt": false,
      "goodOwnerBounds": true
    },
    {
      "id": "35022684",
      "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
      "pairs": 1,
      "parseErrors": false,
      "literalArgsMatch": true,
      "completeSource": false,
      "knownReceipt": false,
      "goodOwnerBounds": true
    },
    {
      "id": "35023582",
      "owner": "su-960a52e7-9b11-42ac-8fe9-7e5e7e0da441",
      "pairs": 1,
      "parseErrors": true,
      "literalArgsMatch": false,
      "completeSource": false,
      "knownReceipt": false,
      "goodOwnerBounds": true
    },
    {
      "id": "35030923",
      "owner": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
      "pairs": 0,
      "parseErrors": false,
      "literalArgsMatch": false,
      "completeSource": false,
      "knownReceipt": false,
      "goodOwnerBounds": false
    },
    {
      "id": "35038763",
      "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
      "pairs": 0,
      "parseErrors": false,
      "literalArgsMatch": false,
      "completeSource": false,
      "knownReceipt": false,
      "goodOwnerBounds": false
    },
    {
      "id": "35039357",
      "owner": "su-449b83a8-a709-43af-9681-768dc6ac744a",
      "pairs": 1,
      "parseErrors": true,
      "literalArgsMatch": false,
      "completeSource": false,
      "knownReceipt": false,
      "goodOwnerBounds": true
    },
    {
      "id": "35042969",
      "owner": "su-449b83a8-a709-43af-9681-768dc6ac744a",
      "pairs": 1,
      "parseErrors": false,
      "literalArgsMatch": false,
      "completeSource": true,
      "knownReceipt": false,
      "goodOwnerBounds": false
    },
    {
      "id": "35044097",
      "owner": "su-ab8cc07f-e903-4467-ac45-a32149258170",
      "pairs": 2,
      "parseErrors": true,
      "literalArgsMatch": true,
      "completeSource": false,
      "knownReceipt": false,
      "goodOwnerBounds": true
    },
    {
      "id": "35045161",
      "owner": "su-b7ae044b-c702-4275-8857-d8c0943bc6f6",
      "pairs": 0,
      "parseErrors": false,
      "literalArgsMatch": false,
      "completeSource": false,
      "knownReceipt": false,
      "goodOwnerBounds": false
    },
    {
      "id": "35045222",
      "owner": "su-960a52e7-9b11-42ac-8fe9-7e5e7e0da441",
      "pairs": 1,
      "parseErrors": false,
      "literalArgsMatch": true,
      "completeSource": false,
      "knownReceipt": false,
      "goodOwnerBounds": true
    },
    {
      "id": "35046578",
      "owner": "su-3067d842-6f5a-41ad-bada-9a47df0ea9a6",
      "pairs": 2,
      "parseErrors": false,
      "literalArgsMatch": true,
      "completeSource": false,
      "knownReceipt": false,
      "goodOwnerBounds": true
    },
    {
      "id": "35047650",
      "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
      "pairs": 1,
      "parseErrors": false,
      "literalArgsMatch": true,
      "completeSource": false,
      "knownReceipt": false,
      "goodOwnerBounds": true
    },
    {
      "id": "35099533",
      "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
      "pairs": 3,
      "parseErrors": true,
      "literalArgsMatch": false,
      "completeSource": true,
      "knownReceipt": false,
      "goodOwnerBounds": true
    },
    {
      "id": "35109461",
      "owner": "su-312c90f2-a3bd-4c92-ac4e-4eae40ae2647",
      "pairs": 2,
      "parseErrors": true,
      "literalArgsMatch": false,
      "completeSource": true,
      "knownReceipt": false,
      "goodOwnerBounds": true
    },
    {
      "id": "35121480",
      "owner": "su-faf26552-0633-4081-a250-172c02f07c19",
      "pairs": 1,
      "parseErrors": true,
      "literalArgsMatch": false,
      "completeSource": false,
      "knownReceipt": false,
      "goodOwnerBounds": false
    },
    {
      "id": "35145396",
      "owner": "su-faf26552-0633-4081-a250-172c02f07c19",
      "pairs": 1,
      "parseErrors": false,
      "literalArgsMatch": true,
      "completeSource": false,
      "knownReceipt": false,
      "goodOwnerBounds": true
    },
    {
      "id": "35232736",
      "owner": "su-d88420f0-c0b4-4dc7-92c7-f60ab3ddab44",
      "pairs": 2,
      "parseErrors": false,
      "literalArgsMatch": true,
      "completeSource": true,
      "knownReceipt": false,
      "goodOwnerBounds": true
    },
    {
      "id": "35239534",
      "owner": "su-312c90f2-a3bd-4c92-ac4e-4eae40ae2647",
      "pairs": 2,
      "parseErrors": false,
      "literalArgsMatch": true,
      "completeSource": false,
      "knownReceipt": false,
      "goodOwnerBounds": true
    },
    {
      "id": "35268060",
      "owner": "su-1415d088-0af5-4299-a5df-8dbfc634335b",
      "pairs": 1,
      "parseErrors": true,
      "literalArgsMatch": false,
      "completeSource": false,
      "knownReceipt": false,
      "goodOwnerBounds": true
    },
    {
      "id": "35277559",
      "owner": "su-4adf5ebc-6443-4c3c-b704-162275765ff1",
      "pairs": 0,
      "parseErrors": false,
      "literalArgsMatch": false,
      "completeSource": false,
      "knownReceipt": false,
      "goodOwnerBounds": false
    },
    {
      "id": "35286001",
      "owner": "su-4adf5ebc-6443-4c3c-b704-162275765ff1",
      "pairs": 1,
      "parseErrors": true,
      "literalArgsMatch": false,
      "completeSource": false,
      "knownReceipt": false,
      "goodOwnerBounds": true
    },
    {
      "id": "35305755",
      "owner": "su-1415d088-0af5-4299-a5df-8dbfc634335b",
      "pairs": 2,
      "parseErrors": false,
      "literalArgsMatch": true,
      "completeSource": false,
      "knownReceipt": false,
      "goodOwnerBounds": true
    }
  ],
  "prior88PreservedExactly": true,
  "limits": [
    "Original137 denominator and prior88 JSON records unchanged.",
    "Completeness,owner,args,native-session,status and original timestamp bounds remain required.",
    "Receipt custody is not process delivery,continuity,eligibility or recovery; refusals remain failures."
  ]
}
