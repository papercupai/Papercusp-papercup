---
rel_path: "audits/parked-agent-resumption-2026-10-09/r13-cold54-seven-source-control-dispositions-424d5.json"
updated_at: 1791995298221
_body: "content"
---

{
  "schemaVersion": "r13-cold54-seven-source-control-dispositions-v1",
  "observedAt": "2026-10-14T16:28:18.214Z",
  "ownerId": "su-424d5476-0b13-401a-a926-0aaa9f212391",
  "workItem": "WI-6554700010008887",
  "cutoff": "2026-10-10T16:00:36.515Z",
  "route": "approved SELF/AUTO/P-013/account/cold",
  "sourceRefs": [
    "audits/parked-agent-resumption-2026-10-09/r13-cold53-seven-source-control-dispositions-v2-424d5.json",
    "audits/parked-agent-resumption-2026-10-09/r13-cold53-seven-source-control-invocations-through-cutoff-424d5.json",
    "audits/parked-agent-resumption-2026-10-09/r13-cold53-seven-original-disarm-revival-source-through-cutoff-424d5.json",
    "audits/parked-agent-resumption-2026-10-09/r13-cold53-original-fleet-kill-control-source-v2-424d5.json",
    "audits/parked-agent-resumption-2026-10-09/r13-cold53-3077-exact-original-stop-native-context-424d5.json",
    "audits/parked-agent-resumption-2026-10-09/r13-cold53-seven-literal-user-control-candidates-provenance-424d5.json",
    "audits/parked-agent-resumption-2026-10-09/r13-cold53-seven-indexed-original-native-session-lineage-424d5.json",
    "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
    "audits/parked-agent-resumption-2026-10-09/r13-cold54-exact-three-injected-control-frames-424d5.json",
    "audits/parked-agent-resumption-2026-10-09/r13-cold54-three-control-message-custody-and-tutorial-handoff-424d5.json"
  ],
  "summary": {
    "cases": 7,
    "controlApplicabilityAccepted": 7,
    "heldItemAssignmentsAccepted": 7,
    "cutoffAssignmentsAccepted": 7,
    "ownerLevelExclusionsAccepted": 3,
    "scopedWaitsAccepted": 4,
    "reviewOpen": 0,
    "other110Ready": false,
    "originalCohort": 116,
    "receiptPopulation": 137,
    "acceptedReceipts": 113,
    "unresolvedReceipts": 24,
    "whole116EligibilityAccepted": 0,
    "continuityAccepted": 0,
    "outcomesJoined": 0
  },
  "cases": [
    {
      "ownerId": "su-298f8b56-c687-404f-99e1-d1c1e53baf0c",
      "controlApplicability": "accepted-owner-directed-migration",
      "heldItemDisposition": "accepted-owner-stop-applies-to-three-held-work-items",
      "cutoffAssignment": "owner-level-exclusion-accepted",
      "ownerCutoffExcluded": true,
      "workRefs": [
        "WI-10006954",
        "WI-10007012",
        "WI-10006967"
      ],
      "evidence": [
        "fleet:kill 32585240 at 2026-10-07T01:56:11.642Z; args.owner matches owner and reason is owner-directed migration",
        "loop:end 32179749 at 2026-10-06T11:33:47.276Z",
        "route-custody originalWaitEvidence i=42; no claim/release direction inferred"
      ]
    },
    {
      "ownerId": "su-3077f62c-1a5d-4be6-896c-e75866032dcb",
      "controlApplicability": "accepted-owner-directed-migration",
      "heldItemDisposition": "accepted-owner-stop-applies-to-eleven-held-work-items",
      "cutoffAssignment": "owner-level-exclusion-accepted",
      "ownerCutoffExcluded": true,
      "workRefs": [
        "WI-10006984",
        "WI-10007019",
        "WI-10007021",
        "WI-10006981",
        "WI-10006985",
        "WI-10007020",
        "WI-10006983",
        "WI-10006963",
        "WI-10006982",
        "WI-10006964",
        "WI-10006962"
      ],
      "evidence": [
        "fleet:kill 32586357 at 2026-10-07T01:57:50.425Z; args.owner matches owner and reason is owner-directed migration",
        "loop:end 32524471 at 2026-10-07T00:08:02.153Z",
        "native parts 61/62 are authenticated continue directives; part72 safety question and part74 voluntary wait do not establish indefinite pause"
      ]
    },
    {
      "ownerId": "su-353a50d8-bcff-423e-9334-9498ed6ff4e9",
      "controlApplicability": "accepted-scoped-leadership-handoff-and-lock-wait",
      "heldItemDisposition": "accepted-scoped-dependency-wait",
      "cutoffAssignment": "retain-owner-in-cohort-no-unjustified-wait",
      "ownerCutoffExcluded": false,
      "workRefs": [
        "WI-10007305"
      ],
      "evidence": [
        "loop:end 33584301 at 2026-10-08T01:22:26.542Z cites leadership transfer and enforced peer source/test locks",
        "loop:end 33614080 at 2026-10-08T02:22:17.432Z cites original failed-native-phase evidence",
        "exact injected control frame at 2026-10-08T03:20:34.365Z is custody disposition, not a new owner pause"
      ]
    },
    {
      "ownerId": "su-684c584a-3351-49ee-a145-f657d7e42237",
      "controlApplicability": "accepted-system-guard-not-owner-pause",
      "heldItemDisposition": "accepted-scoped-blocked-and-recovery-waits",
      "cutoffAssignment": "retain-owner-in-cohort-no-unjustified-wait",
      "ownerCutoffExcluded": false,
      "workRefs": [
        "EI-25327682039407935",
        "EI-25380637492003672",
        "WI-10007106"
      ],
      "evidence": [
        "loop:end 32404575 at 2026-10-06T20:24:23.389Z preserves blocked native pickup and existing watches",
        "loop:end 32434304 at 2026-10-06T21:23:29.632Z stops one-fire response monitor after concrete reply",
        "fleet:kill 32460530 targets su-7afe5ac1, not this owner",
        "auto-pause disarm 2026-10-08T16:14:34.602397Z is stalled-loop guard; not owner pause"
      ]
    },
    {
      "ownerId": "su-d759f7bc-0b18-43bd-8945-b839fa0e54c9",
      "controlApplicability": "accepted-scoped-source-repair-waits",
      "heldItemDisposition": "accepted-scoped-dependency-and-custody-wait",
      "cutoffAssignment": "retain-owner-in-cohort-no-unjustified-wait",
      "ownerCutoffExcluded": false,
      "workRefs": [
        "WI-10007468"
      ],
      "evidence": [
        "loop:end 33666407 at 2026-10-08T04:29:26.792Z cites two concrete source repairs with exact awaits",
        "loop:end 33946244 at 2026-10-08T12:41:42.262Z preserves blocked custody disposition",
        "disarms 2026-10-08T04:29,10:43,12:21,18:15 are bounded handoff/guard transitions, not an owner-level pause"
      ]
    },
    {
      "ownerId": "su-ec24b79e-fb5f-4056-847e-c1bd3edfec3a",
      "controlApplicability": "accepted-bounded-lock-wait-and-duration-guard",
      "heldItemDisposition": "accepted-bounded-budget-or-time-bound-wait",
      "cutoffAssignment": "retain-owner-in-cohort-no-unjustified-wait",
      "ownerCutoffExcluded": false,
      "workRefs": [
        "EI-25477838487191856"
      ],
      "evidence": [
        "loop:end 34483948 at 2026-10-09T07:04:24.854Z follows refused stop while waiting on active git-sync lock",
        "auto-pause disarm 2026-10-09T08:40:05.146013Z is max-duration guard",
        "resume condition names one bounded monitor wake and lock recheck"
      ]
    },
    {
      "ownerId": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
      "controlApplicability": "accepted-owner-verified-handoff-and-resume",
      "heldItemDisposition": "accepted-clean-handoff-to-new-owner",
      "cutoffAssignment": "owner-level-exclusion-accepted",
      "ownerCutoffExcluded": true,
      "workRefs": [
        "EI-24922683639239432",
        "EI-24870209437597571",
        "EI-24923992688505913"
      ],
      "evidence": [
        "exact control message coord-send-59113225... at 2026-10-01T16:49:37.968Z lifts prior pause and directs resume",
        "exact control message coord-send-830306... at 2026-10-05T17:44:21.015Z records su-7a94555d claim of WI-10004837/P-010/P-012",
        "plan D-021 records personal AUTO takeover after original process exited and clean release before transfer",
        "loop:end 31720878 at 2026-10-05T17:42:21.933Z records explicit owner-verified handoff"
      ]
    }
  ],
  "limitations": [
    "Owner-level exclusion means excluded from the unjustified-wait predicate; it does not join recovery outcomes or certify whole-cohort continuity.",
    "worked_by_history has no claim/release direction; held-item refs are retained witnesses, not inferred transitions.",
    "Original018 emitted evidence spill remains incomplete/expired; its four-item assignment chronology remains review-open and is not replaced by this seven-case artifact.",
    "No source edits, product tests, acquisitions, native replay, restore, route/account changes, gate operations or terminal closes were performed."
  ],
  "retractedClaims": [
    "v1 sourceControlResolved7 and temporal supersession claims are withdrawn; see WI-6554700010008887 comments 1181266 and 1181276."
  ]
}
