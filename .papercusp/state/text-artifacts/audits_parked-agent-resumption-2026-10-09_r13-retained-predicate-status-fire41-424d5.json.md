---
rel_path: "audits/parked-agent-resumption-2026-10-09/r13-retained-predicate-status-fire41-424d5.json"
updated_at: 1792009935810
_body: "content"
---

{
  "schemaVersion": "parked-r13-retained-predicate-status-fire41-v1",
  "observedAt": "2026-10-14T20:31:51Z",
  "ownerId": "su-424d5476-0b13-401a-a926-0aaa9f212391",
  "workItem": "WI-6554700010008887",
  "plan": "parked-agent-census-resumption-and-root-cause-2026-10-09",
  "route": "approved SELF/AUTO; original account/carry retained",
  "cutoff": "2026-10-10T16:00:36.515Z",
  "cohortHash": "24ff6981fd54f120f96381dd93732ec9c1bfb2101d7eec063119bf85caeb163a",
  "sourceRefs": [
    "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json",
    "audits/parked-agent-resumption-2026-10-09/r13-five-wait-control-residue-20261014-424d5.json",
    "audits/parked-agent-resumption-2026-10-09/r13-five-wait-frozen-work-reference-history-20261014T1933-424d5.json",
    "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
    "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json"
  ],
  "liveClaimVerification": [
    {
      "id": "WI-6554700010008887",
      "assignee": "su-424d5476-0b13-401a-a926-0aaa9f212391",
      "state": "open",
      "finding": "No terminal acceptance; Fire40 report and archive remain authoritative."
    },
    {
      "id": "WI-10008164",
      "assignee": "su-424d5476-0b13-401a-a926-0aaa9f212391",
      "state": "open",
      "planItem": "P-013",
      "finding": "Continue retained dated predicates; freeze eligibility/continuity before outcomes."
    },
    {
      "id": "WI-10008017",
      "assignee": "su-424d5476-0b13-401a-a926-0aaa9f212391",
      "state": "open",
      "finding": "Parent acceptance open; historical six-case checks do not freeze whole116."
    },
    {
      "id": "EI-25979903471463680",
      "assignee": "su-424d5476-0b13-401a-a926-0aaa9f212391",
      "state": "open",
      "finding": "Current wake 806955 was invoked; original018 final-cutoff admission, guarantee, and pickup remain unproven."
    },
    {
      "id": "EI-25927909729992864",
      "assignee": "su-424d5476-0b13-401a-a926-0aaa9f212391",
      "state": "open",
      "finding": "Retained routine-output custody gap remains open; no reacquisition, restore, or replay."
    },
    {
      "id": "EI-25879870290163805",
      "assignee": "su-424d5476-0b13-401a-a926-0aaa9f212391",
      "state": "open",
      "finding": "Original137 receipt instrument remains 113 accepted and 24 unresolved; parser/source gap remains open."
    }
  ],
  "retainedPredicates": {
    "independent110": {
      "population": 110,
      "priorSourceDecisionCounts": {
        "resume-candidate": 67,
        "justified-scoped-wait": 12,
        "no-prior273": 20,
        "justified-owner-stop-or-handoff": 3,
        "justified-owner-pause": 3,
        "justified-recorded-dependency": 3,
        "justified-idle-or-handoff": 1,
        "justified-budget-or-time-bound": 1
      },
      "governingSevenCasesJoined": 7,
      "governingSevenReviewOpen": 7,
      "rowsReviewOpen": 110,
      "eligibilityAccepted": false,
      "continuityAccepted": false,
      "outcomesJoined": 0
    },
    "fiveWaitControlResidue": {
      "rows": 5,
      "waitCalls": 6,
      "historicalWaitEvidence": "present",
      "finalCutoffApplicabilityAccepted": 0,
      "cutoffContinuityAccepted": 0,
      "eligibilityAccepted": 0,
      "outcomesJoined": 0,
      "allRows": "retain review-open; exact source ids/times preserved"
    },
    "historicalSix": {
      "sourceAssessments": "Fire30: 4 eligible / 2 excluded",
      "whole116EligibilityFrozen": false,
      "outcomesJoined": 0
    },
    "whole116": {
      "originalPopulation": 116,
      "originalReceiptPopulation": 137,
      "acceptedReceipts": 113,
      "unresolvedReceipts": 24,
      "eligibilityAccepted": false,
      "continuityAccepted": false,
      "outcomesJoined": 0
    }
  },
  "wakeProgress": {
    "eventKey": "coord:inbox-wake:su-424d5476-0b13-401a-a926-0aaa9f212391",
    "firedCount": 54,
    "latestDeliveryId": 807427,
    "latestDeliveryStatus": "delivered",
    "latestTurnInvoked": true,
    "loopActive": true,
    "loopIntervalSec": 300,
    "loopFireCount": 41
  },
  "decision": "Do not promote any row or join outcomes. Keep original018 authority/guaranteed rewake/pickup, complete held-control applicability, cutoff continuity, R5, root961, R12 current proof, final runtime anchor, and >=24h R14 open.",
  "limits": [
    "Dated wait or loop calls establish historical control evidence only; they do not prove final-cutoff authority, pickup, or later continuity.",
    "The six historical source assessments and five-wait residue are not a whole116 eligibility freeze.",
    "No completed population query, test, native acquisition/replay/restore, terminal close, LIVE_GATE_OPS, route/account/carry change, or outcome join was performed."
  ]
}
