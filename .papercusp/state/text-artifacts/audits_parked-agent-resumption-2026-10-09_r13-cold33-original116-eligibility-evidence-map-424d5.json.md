---
rel_path: "audits/parked-agent-resumption-2026-10-09/r13-cold33-original116-eligibility-evidence-map-424d5.json"
updated_at: 1791910595920
_body: "content"
---

{
  "schemaVersion": "r13-cold33-original116-eligibility-evidence-map-v1",
  "observedAt": "2026-10-13T16:56:32.864Z",
  "ownerId": "su-424d5476-0b13-401a-a926-0aaa9f212391",
  "route": "approved SELF/AUTO/P-013/account/cold",
  "workItem": "WI-6554700010008887",
  "plan": "parked-agent-census-resumption-and-root-cause-2026-10-09",
  "cohortHash": "24ff6981fd54f120f96381dd93732ec9c1bfb2101d7eec063119bf85caeb163a",
  "cutoff": "2026-10-10T16:00:36.515Z",
  "sourceRefs": [
    {
      "key": "candidates",
      "ref": "audits/parked-agent-resumption-2026-10-09/r13-original116-candidates-fire15-v2-424d5.json",
      "chars": 154382,
      "sha256": "068bf560d28fa7354ca1cb194bcf0c625a036411941dd4ed81df17a69a99bdf2"
    },
    {
      "key": "routes",
      "ref": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
      "chars": 588094,
      "sha256": "f7c3a7f923d1725ffbded27ee2696ba38883b8251601e425c69b9b00d0721fe3"
    },
    {
      "key": "controls",
      "ref": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
      "chars": 52871,
      "sha256": "6935b63c0a24fc8423c3139342364f7f53cb4df83d79a68cb7921192c4d11dda"
    },
    {
      "key": "six",
      "ref": "audits/parked-agent-resumption-2026-10-09/r13-six-cutoff-wait-evidence-fire30-424d5.json",
      "chars": 30474,
      "sha256": "5ed48d944471487cbb1a4168881ad569d610d27cf1ef85f20e08e6705ddefdde"
    },
    {
      "key": "transitions",
      "ref": "audits/parked-agent-resumption-2026-10-09/r13-new26-cutoff-transition-witnesses-fire17-424d5.json",
      "chars": 55989,
      "sha256": "b20761d95b0438de2865c0d958141f6a2bd4fa20318bac6e9b9a48f43a11f9bb"
    },
    {
      "key": "receipts",
      "ref": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json",
      "chars": 3191124,
      "sha256": "2f0817467ff18f74a91fffda4d983ab1a5d0c2e669a0569809761c28a638c18c"
    },
    {
      "key": "review",
      "ref": "audits/parked-agent-resumption-2026-10-09/r13-cold32-existing-original24-custody-and-native-frame-review-v2-424d5.json",
      "chars": 300927,
      "sha256": "47e854abd110993d693c07312cd4c1c8fb80e4ad0d27afa2732d7c5b8b1d8ff3"
    }
  ],
  "rows": [
    {
      "ownerId": "su-01864986-d27d-497b-b501-7082b6e0caab",
      "candidateReason": "silent-since-failed-respawn",
      "frozenClaimCount": 4,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "WI-10006302",
          "EI-25433658765688677",
          "EI-25493141603129186",
          "EI-25436508475172020"
        ],
        "stopReason": "",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "cold",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-079b1c14-07ec-495e-b640-6a60f89180e2",
      "candidateReason": "silent-since-failed-respawn",
      "frozenClaimCount": 2,
      "frozenParkedOn": [
        "conversation:answered:conv-mv180smt-0000-0ce84e484f5d460abf23bd10e4b793eb"
      ],
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "justified-scoped-wait",
        "workRefs": [
          "EI-25424493689922706",
          "WI-10007428"
        ],
        "stopReason": "",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "cold",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-07eba67b-e1f4-48ec-9f2f-8e518ecb6eec",
      "candidateReason": "native-error",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "EI-25211196669462013"
        ],
        "stopReason": "",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "warm",
        "witnessAt": "2026-10-06T06:20:36.092Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-08885e73-2abb-4866-bb49-4d876822fa05",
      "candidateReason": "silent-since-failed-respawn",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "justified-scoped-wait",
        "workRefs": [
          "EI-25298454793100957"
        ],
        "stopReason": "stalled-loops-guard (WI-6639): turns-stalled: 17 fire(s), last fired 2026-10-08T11:04:02.742Z, last turn 2026-10-07T22:02:39.381Z",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "warm",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
      "candidateReason": "silent-since-failed-respawn",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": null,
      "ambiguousWorkedByItemRefs": [
        "EI-24375634984501450",
        "EI-24816398540446811",
        "EI-25324371882189406",
        "EI-25326023580020405",
        "EI-25354264910204447",
        "EI-25473800961809533",
        "EI-25489877550345710",
        "EI-25518316230443082",
        "EI-25518476930001342",
        "EI-25519734441837999",
        "EI-25527207529708796",
        "EI-25530012732462659",
        "EI-25533596092804030",
        "EI-25546536704309473",
        "WI-10007941"
      ],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "cold",
        "witnessAt": "2026-10-09 16:47:39.148+00",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [
          "34836154"
        ],
        "compactionRequestIds": [
          "34777625",
          "34778962",
          "34800973",
          "34826842",
          "34836638",
          "34863926",
          "34875390",
          "34887447",
          "34902121",
          "34920158",
          "34952665",
          "35031846",
          "35047650",
          "35064368",
          "35086665",
          "35099533",
          "35109557",
          "35120408"
        ],
        "accepted": false
      },
      "originalReceiptReferences": [
        {
          "requestId": "34777625",
          "receiptState": "flush-refused",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "34778962",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "34836638",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "34902121",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "34920158",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "35086665",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "35109557",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "34800973",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "34826842",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "34863926",
          "receiptState": "unresolved",
          "acceptedUnique": false,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "34875390",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "34887447",
          "receiptState": "unresolved",
          "acceptedUnique": false,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "34952665",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "35031846",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "35047650",
          "receiptState": "unresolved",
          "acceptedUnique": false,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "35064368",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "35099533",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "35120408",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        }
      ],
      "missingFullOriginalSources": [
        {
          "requestId": "34863926",
          "nativeIds": [
            "01a12212-c9fe-7921-bc00-6644cf505bab",
            "01a12228-9932-7040-a68b-192083ea9f40"
          ],
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold32-existing-original24-custody-and-native-frame-review-v2-424d5.json",
          "sourceLossProven": false
        },
        {
          "requestId": "34887447",
          "nativeIds": [
            "01a1223d-8d3b-73d2-ba27-19a009e9bfc7",
            "01a12252-f80e-7341-b478-2a4df19537b8"
          ],
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold32-existing-original24-custody-and-native-frame-review-v2-424d5.json",
          "sourceLossProven": false
        }
      ],
      "retainedUnacceptedNativeFrames": [
        {
          "requestId": "35047650",
          "owner": "EI-25879870290163805",
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold32-existing-original24-custody-and-native-frame-review-v2-424d5.json",
          "receiptAccepted": false
        }
      ],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-0e53c244-5ba3-4d96-b499-4e233e3a8936",
      "candidateReason": "native-error",
      "frozenClaimCount": 3,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "EI-25255114763167801",
          "EI-25232091867268715"
        ],
        "stopReason": "",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "warm",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-0f45ebc8-24a7-4e9b-9fee-35a3c72290d0",
      "candidateReason": "silent-since-failed-respawn",
      "frozenClaimCount": 2,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "EI-25315365359912824",
          "WI-10006978"
        ],
        "stopReason": "stalled-loops-guard (WI-6639): turns-stalled: 7 fire(s), last fired 2026-10-07T23:52:47.614Z, last turn 2026-10-07T22:57:19.189Z",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "cold",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-0f674e05-72fb-4dfa-9078-47f7f93ccf8c",
      "candidateReason": "native-error",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "EI-25231993121569784"
        ],
        "stopReason": "stalled-loops-guard (WI-6639): turns-stalled: 9 fire(s), last fired 2026-10-06T18:06:01.944Z, last turn 2026-10-06T17:31:54.535Z",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "warm",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-0fbe2904-7a7b-48d5-b3b7-da81d592f41d",
      "candidateReason": "silent-since-failed-respawn",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "WI-10007398"
        ],
        "stopReason": "stalled-loops-guard (WI-6639): turns-stalled: 13 fire(s), last fired 2026-10-09T05:08:42.794Z, last turn 2026-10-08T21:04:28.838Z",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "warm",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-1020321d-4f7c-4257-a245-c2461a585b62",
      "candidateReason": "silent-since-failed-respawn",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": null,
      "ambiguousWorkedByItemRefs": [
        "EI-24726536029844389",
        "EI-24958984626145573",
        "EI-25303447529081778",
        "EI-25371334460583936",
        "EI-25376635449301072",
        "EI-25473800961809533"
      ],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "warm",
        "witnessAt": "2026-10-10 02:01:31.967+00",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [
          "35066688",
          "35090157"
        ],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-12c1bd39-1548-483c-b529-2888ce105cee",
      "candidateReason": "native-error",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "EI-25239099539499855"
        ],
        "stopReason": "stalled-loops-guard (WI-6639): turns-stalled: 17 fire(s), last fired 2026-10-06T18:06:34.101Z, last turn 2026-10-06T17:13:47.439Z",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "warm",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-1415d088-0af5-4299-a5df-8dbfc634335b",
      "candidateReason": "silent-since-failed-respawn",
      "frozenClaimCount": 2,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": null,
      "ambiguousWorkedByItemRefs": [
        "EI-21311104008618657",
        "EI-25205526314986786",
        "EI-25248675192543911",
        "EI-25372449299506799",
        "EI-25395605811228800",
        "EI-25399100864683043",
        "EI-25505007242541284",
        "EI-25521910842775592",
        "EI-25529817219750684",
        "EI-25532369368153081",
        "EI-25534069434152138",
        "EI-25535413115473461",
        "EI-25535969725594610",
        "EI-25537287061940193",
        "EI-25540011507167770",
        "EI-25544464659717054",
        "EI-25552749816839039",
        "EI-25558951306471827",
        "EI-25578944877737118"
      ],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "cold",
        "witnessAt": "2026-10-10 08:37:35.026+00",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [
          "35246962",
          "35257928",
          "35268060",
          "35284056",
          "35305755"
        ],
        "accepted": false
      },
      "originalReceiptReferences": [
        {
          "requestId": "35284056",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "35246962",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "35257928",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "35268060",
          "receiptState": "unresolved",
          "acceptedUnique": false,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "35305755",
          "receiptState": "unresolved",
          "acceptedUnique": false,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        }
      ],
      "missingFullOriginalSources": [
        {
          "requestId": "35268060",
          "nativeIds": [
            "01a12513-3862-7261-ae4a-79265df0b73a"
          ],
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold32-existing-original24-custody-and-native-frame-review-v2-424d5.json",
          "sourceLossProven": false
        },
        {
          "requestId": "35305755",
          "nativeIds": [
            "01a1254c-cc9a-75c0-9c26-f5e67d2b79a3",
            "01a1257d-6598-73a3-97b9-bbaf7f11c96f"
          ],
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold32-existing-original24-custody-and-native-frame-review-v2-424d5.json",
          "sourceLossProven": false
        }
      ],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-14f4c057-33ba-432c-9207-cc57855abdf8",
      "candidateReason": "native-error",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "WI-10006539"
        ],
        "stopReason": "stalled-loops-guard (WI-6639): turns-stalled: 10 fire(s), last fired 2026-10-06T17:58:30.757Z, last turn 2026-10-06T16:50:35.863Z",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "warm",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-17442b70-89a3-4ea5-82bb-9d0ca2cab71e",
      "candidateReason": "native-error",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "EI-25253433578112917"
        ],
        "stopReason": "stalled-loops-guard (WI-6639): turns-stalled: 12 fire(s), last fired 2026-10-06T21:08:02.239Z, last turn 2026-10-06T19:54:07.856Z",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "warm",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-174cad2e-5b58-42a5-858e-3925c0a45b81",
      "candidateReason": "native-error",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "EI-24958945974387688"
        ],
        "stopReason": "stalled-loops-guard (WI-6639): turns-stalled: 12 fire(s), last fired 2026-10-06T17:58:30.762Z, last turn 2026-10-06T16:53:00.667Z",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "warm",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-18cc8df4-7a58-493c-a584-5975027af3ad",
      "candidateReason": "silent-since-failed-respawn",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "WI-10007104"
        ],
        "stopReason": "stalled-loops-guard (WI-6639): turns-stalled: 11 fire(s), last fired 2026-10-07T22:00:37.871Z, last turn 2026-10-07T20:56:59.653Z",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "cold",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-1ece32b6-7d83-4bcc-a4de-52bd136d570f",
      "candidateReason": "native-error",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "EI-25248391444384694"
        ],
        "stopReason": "stalled-loops-guard (WI-6639): turns-stalled: 9 fire(s), last fired 2026-10-06T20:45:34.339Z, last turn 2026-10-06T20:14:51.321Z",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "cold",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-210ffd48-6f47-4a3d-85bc-1b3617b9b139",
      "candidateReason": "native-error",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "EI-25226279926810608"
        ],
        "stopReason": "stalled-loops-guard (WI-6639): turns-stalled: 18 fire(s), last fired 2026-10-06T18:00:32.263Z, last turn 2026-10-06T17:11:17.249Z",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "warm",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-298f8b56-c687-404f-99e1-d1c1e53baf0c",
      "candidateReason": "native-error",
      "frozenClaimCount": 4,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "justified-owner-stop-or-handoff",
        "workRefs": [
          "WI-10006954",
          "WI-10007012",
          "WI-10006967"
        ],
        "stopReason": "fleet:kill — Owner-directed migration of six-hour Claude census to headless GPT-6.1 Sol; terminate predecessor before identity-preserving recovery.",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "cold",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-2a56400c-0263-46b7-9667-fe2ac22cec80",
      "candidateReason": "silent-since-failed-respawn",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "EI-25334931475249217"
        ],
        "stopReason": "stalled-loops-guard (WI-6639): turns-stalled: 17 fire(s), last fired 2026-10-08T11:04:02.952Z, last turn 2026-10-07T23:27:28.147Z",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "warm",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-3067d842-6f5a-41ad-bada-9a47df0ea9a6",
      "candidateReason": "silent-since-failed-respawn",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": null,
      "ambiguousWorkedByItemRefs": [
        "EI-25495177729392533",
        "EI-25501457254010553"
      ],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "cold",
        "witnessAt": "2026-10-09 23:49:17.159+00",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [
          "35002303",
          "35028001",
          "35036424",
          "35046578"
        ],
        "accepted": false
      },
      "originalReceiptReferences": [
        {
          "requestId": "35002303",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "35028001",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "35036424",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "35046578",
          "receiptState": "unresolved",
          "acceptedUnique": false,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        }
      ],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [
        {
          "requestId": "35046578",
          "owner": "EI-25879870290163805",
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold32-existing-original24-custody-and-native-frame-review-v2-424d5.json",
          "receiptAccepted": false
        }
      ],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-3077f62c-1a5d-4be6-896c-e75866032dcb",
      "candidateReason": "native-error",
      "frozenClaimCount": 11,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "justified-owner-stop-or-handoff",
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
        "stopReason": "Owner stopped my tool use and asked me to wait for their go-ahead. Ending the 2-minute loop so its wakes don't restart work behind the owner's back. Re-arm with the same goal (carry gate-throughput-shift-left-2026-10-06 to shipped) once the owner says continue.",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "warm",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-312c90f2-a3bd-4c92-ac4e-4eae40ae2647",
      "candidateReason": "silent-since-failed-respawn",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": null,
      "ambiguousWorkedByItemRefs": [
        "EI-23247248637745800",
        "EI-24353523932945810",
        "EI-25432046366219607",
        "EI-25433425797597550",
        "EI-25537519473162546",
        "EI-25538866208011305",
        "EI-25547547333094320",
        "EI-25551197624784495",
        "EI-25552550438078076",
        "EI-25556584571867080",
        "EI-25560327627102270",
        "EI-25564360557802094",
        "EI-25574253034038454",
        "WI-10007572",
        "WI-10008036"
      ],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "cold",
        "witnessAt": "2026-10-09 23:12:56.031+00",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [
          "34983377",
          "35040409",
          "35063976",
          "35089988",
          "35109461",
          "35119644",
          "35239534"
        ],
        "accepted": false
      },
      "originalReceiptReferences": [
        {
          "requestId": "35040409",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "34983377",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "35063976",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "35089988",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "35109461",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "35119644",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "35239534",
          "receiptState": "unresolved",
          "acceptedUnique": false,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        }
      ],
      "missingFullOriginalSources": [
        {
          "requestId": "35239534",
          "nativeIds": [
            "01a124df-4dc0-7741-97a6-73362938b29d"
          ],
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold32-existing-original24-custody-and-native-frame-review-v2-424d5.json",
          "sourceLossProven": false
        }
      ],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-340db785-4864-494c-9d24-d9c3d4ce2f6c",
      "candidateReason": "native-error",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "EI-25243638346303177"
        ],
        "stopReason": "stalled-loops-guard (WI-6639): turns-stalled: 8 fire(s), last fired 2026-10-06T18:06:01.958Z, last turn 2026-10-06T17:33:02.815Z",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "warm",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-353a50d8-bcff-423e-9334-9498ed6ff4e9",
      "candidateReason": "native-error",
      "frozenClaimCount": 1,
      "frozenParkedOn": [
        "coord:inbox-wake:su-353a50d8-bcff-423e-9334-9498ed6ff4e9"
      ],
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "justified-owner-pause",
        "workRefs": [
          "WI-10007305"
        ],
        "stopReason": "Fleet leadership transferred; obsolete supervision loop must stop. Owned WI-10007305 is blocked on enforced peer source/test locks. Ticket c6fefb66-c094-479b-bdc4-1c096f6732b8 has deliberate registered grant wake await244096 and bounded lapse wake. Checkpoints saved; resume regression/fix as member on grant.",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "warm",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-35487441-ba34-4a1d-ba7f-839d3585becf",
      "candidateReason": "silent-since-failed-respawn",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "EI-25418215735104183"
        ],
        "stopReason": "stalled-loops-guard (WI-6639): turns-stalled: 13 fire(s), last fired 2026-10-09T05:09:06.595Z, last turn 2026-10-08T20:54:27.572Z",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "warm",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-35abc0ff-4711-4e19-bcaf-07e6ff0da983",
      "candidateReason": "silent-since-failed-respawn",
      "frozenClaimCount": 4,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "EI-25320521268576929"
        ],
        "stopReason": "stalled-loops-guard (WI-6639): turns-stalled: 94 fire(s), last fired 2026-10-08T23:59:33.834Z, last turn 2026-10-08T23:09:24.115Z",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "cold",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-36986ccc-d8dc-4139-bf7a-9363281b06c8",
      "candidateReason": "silent-since-failed-respawn",
      "frozenClaimCount": 6,
      "frozenParkedOn": [
        "work-item:unblocked:WI-10007947"
      ],
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": null,
      "ambiguousWorkedByItemRefs": [
        "EI-25351164033770312",
        "EI-25537097503497667",
        "EI-25539483722656700",
        "WI-10007840",
        "WI-10007947"
      ],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-six-cutoff-wait-evidence-fire30-424d5.json",
        "assessment": {
          "status": "eligible-source-supported",
          "reason": "Original AUTO/self root had completed SPA build and a named candidate snapshot verification followed by maintained native verification; archive publication was a separate dependency."
        },
        "evidence": [
          {
            "source": "/home/marsh-office/.papercusp/su-codex-homes/session-39208/sessions/2026/10/09/rollout-2026-10-09T20-32-26-01a12339-b21b-7180-8a20-74098ed25ade.jsonl",
            "line": 1254,
            "timestamp": "2026-10-10T01:46:52.772Z",
            "lineSha256": "d69520b84c6eee8e1966732da41c193dc447de37de274589f6a683b7f1c43bbc",
            "text": "The matching frontend build passed, and the evidence-file quarantine is fixed and verified. Native acceptance and shipment remain pending. Progress is checkpointed, with compaction queued."
          },
          {
            "status": "no-literal-call-witness-selected"
          }
        ],
        "limit": "Existing supplemental source support; does not freeze whole116 membership or certify cutoff route continuity"
      },
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "warm",
        "witnessAt": "2026-10-09 22:20:04.111+00",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [
          "34975377",
          "35060123"
        ],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Preserve existing source assessment; verify exact cutoff assignment/control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-3790bff3-9f96-445b-a6f5-bddc36f217bf",
      "candidateReason": "native-error",
      "frozenClaimCount": 4,
      "frozenParkedOn": [
        "coord:inbox-wake:su-3790bff3-9f96-445b-a6f5-bddc36f217bf"
      ],
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "WI-10004773",
          "EI-25304604912636832",
          "EI-25305482120815536"
        ],
        "stopReason": "P-006 local verification/registration and bounded retained-evidence diagnosis completed this turn; remaining acceptance depends on Avi hostedCI billing/scope answer. Existing exact conversation-answer await remains armed; do not burn no-delta original-diagnostic wakes.",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "warm",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-3e76622f-f481-4032-b89c-8015f2dfa6b5",
      "candidateReason": "silent-since-failed-respawn",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "EI-25350185714618008"
        ],
        "stopReason": "stalled-loops-guard (WI-6639): turns-stalled: 9 fire(s), last fired 2026-10-07T21:42:49.912Z, last turn 2026-10-07T21:02:42.249Z",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "cold",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-449b83a8-a709-43af-9681-768dc6ac744a",
      "candidateReason": "silent-since-failed-respawn",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": null,
      "ambiguousWorkedByItemRefs": [
        "EI-25481493419888263",
        "EI-25520137253860284",
        "EI-25541397051460120",
        "EI-25543676997144729",
        "EI-25544304590998746"
      ],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "cold",
        "witnessAt": "2026-10-09 23:15:12.114+00",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [
          "35020841",
          "35030421",
          "35039357",
          "35042969"
        ],
        "accepted": false
      },
      "originalReceiptReferences": [
        {
          "requestId": "35030421",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "35020841",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "35039357",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "35042969",
          "receiptState": "unresolved",
          "acceptedUnique": false,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        }
      ],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [
        {
          "requestId": "35042969",
          "owner": "EI-25879870290163805",
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold32-existing-original24-custody-and-native-frame-review-v2-424d5.json",
          "receiptAccepted": false
        }
      ],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-449d831c-b3e3-4fad-8816-cc35d56c30cc",
      "candidateReason": "native-error",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "EI-25238385467055867"
        ],
        "stopReason": "stalled-loops-guard (WI-6639): turns-stalled: 11 fire(s), last fired 2026-10-06T18:58:03.115Z, last turn 2026-10-06T17:53:20.395Z",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "warm",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-4a152da3-3ef7-420f-a82b-bfab10cf563a",
      "candidateReason": "native-error",
      "frozenClaimCount": 11,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "WI-10006955",
          "EI-25303741091409100",
          "EI-25308844615842496",
          "WI-10006904",
          "EI-25304899570274056",
          "WI-10006226",
          "EI-25308890162896389",
          "WI-10006229",
          "WI-10006230",
          "WI-10006231"
        ],
        "stopReason": "Await240194 independently wakes final shipment verification on publisher WI10004339 completion; periodic no-delta loop unnecessary. Shipment directives remain open.",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "warm",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-4adf5ebc-6443-4c3c-b704-162275765ff1",
      "candidateReason": "silent-since-failed-respawn",
      "frozenClaimCount": 2,
      "frozenParkedOn": [
        "conversation:answered:conv-mv1ui9dh-0000-567d99f0350a4eb7bf519089b2950138",
        "coord:inbox-wake:su-4adf5ebc-6443-4c3c-b704-162275765ff1"
      ],
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": null,
      "ambiguousWorkedByItemRefs": [
        "EI-25428079282341439",
        "EI-25430021485502676",
        "EI-25483605586416711",
        "EI-25483656433952624",
        "EI-25483747016701596",
        "EI-25581475380005098",
        "WI-10007832"
      ],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-six-cutoff-wait-evidence-fire30-424d5.json",
        "assessment": {
          "status": "excluded-source-supported-dependency-wait",
          "reason": "Retained 12:22:24Z conclusion records both capture items blocked, root/retention/fresh-origin dependency unsatisfied, owner scope unanswered, and bounded independent trace investigation already completed. Pre-outcome source-supported exclusion."
        },
        "evidence": [
          {
            "sourceRef": "session_turn:codex:01a125b4-15cc-7d41-8499-3be49aaffbe1:24",
            "timestamp": "2026-10-10 12:09:08.709+00",
            "text": "The live inbox has no unanswered direct messages. The recovery notice at 12:03 is for an inference account; the leader’s shared-headroom gate is still declared and requires fresh disk, retention, and origin receipts. I’m checking the remaining independent capture-trace path now.",
            "textSha256": "877724b108687c2969c63a2a9df04ce11cabadf4590dad2a6e7bcbe8aa480f00",
            "sourceLimit": "retained indexed part, not a native call-id binding"
          },
          {
            "sourceRef": "session_turn:codex:01a125b4-15cc-7d41-8499-3be49aaffbe1:115",
            "timestamp": "2026-10-10 12:22:24.963+00",
            "text": "Reoriented and verified both items remain blocked and assigned. The root-headroom gate is still declared; the account-burn recovery does not satisfy its disk, retention, and fresh-origin conditions. Avi’s scope conversation remains open and unanswered.\n\nI found the historical capture invocation: 48.669 seconds on build `37536eb0ad`. No matching MCP trace was found in the accessible journal, and the handler’s phase timing was added later, so the root cause remains unknown. I made no code changes and ran no tests.\n\nBoth work items and the loop are checkpointed. The exact headroom event await is registered, and successor compaction is queued.",
            "textSha256": "562d58d35b4326aff3caeb87c19018ed6b69a07d7de9e1b8f46d4c95f8aff498",
            "sourceLimit": "retained indexed part, not a native call-id binding"
          }
        ],
        "limit": "Existing supplemental source support; does not freeze whole116 membership or certify cutoff route continuity"
      },
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "cold",
        "witnessAt": "2026-10-10 09:57:44.521+00",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [
          "35277559",
          "35286001",
          "35342589"
        ],
        "accepted": false
      },
      "originalReceiptReferences": [
        {
          "requestId": "35342589",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "35277559",
          "receiptState": "unresolved",
          "acceptedUnique": false,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "35286001",
          "receiptState": "unresolved",
          "acceptedUnique": false,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        }
      ],
      "missingFullOriginalSources": [
        {
          "requestId": "35277559",
          "nativeIds": [
            "01a1252d-875a-7600-b7c0-29f98f6791f2",
            "01a1253f-e361-75a0-a286-aeb68a8fb97d"
          ],
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold32-existing-original24-custody-and-native-frame-review-v2-424d5.json",
          "sourceLossProven": false
        },
        {
          "requestId": "35286001",
          "nativeIds": [
            "01a1253f-e361-75a0-a286-aeb68a8fb97d"
          ],
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold32-existing-original24-custody-and-native-frame-review-v2-424d5.json",
          "sourceLossProven": false
        }
      ],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Preserve existing source assessment; verify exact cutoff assignment/control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-4e1fbeb0-d056-4e46-b5a6-27d2a6e9df58",
      "candidateReason": "native-error",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "EI-25246871066483280"
        ],
        "stopReason": "stalled-loops-guard (WI-6639): turns-stalled: 11 fire(s), last fired 2026-10-06T18:59:32.908Z, last turn 2026-10-06T18:07:23.336Z",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "warm",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-4f6ea469-1018-4149-ad55-3fb2883e404a",
      "candidateReason": "native-error",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "EI-25236880567981100"
        ],
        "stopReason": "stalled-loops-guard (WI-6639): turns-stalled: 16 fire(s), last fired 2026-10-06T18:02:31.930Z, last turn 2026-10-06T17:03:36.129Z",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "warm",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-517bc2b4-a5c0-447b-96a2-bc3f1940ceca",
      "candidateReason": "silent-since-failed-respawn",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "justified-recorded-dependency",
        "workRefs": [
          "EI-25525063270905341"
        ],
        "stopReason": "",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "cold",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-533a9a79-33ef-487f-876c-41ac39337175",
      "candidateReason": "silent-since-failed-respawn",
      "frozenClaimCount": 2,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "EI-25439358535957912",
          "EI-25346788221331817"
        ],
        "stopReason": "loop:end — deactivated by its owner",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "cold",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-54c73bd5-e418-4a16-ba65-0a825b32ed50",
      "candidateReason": "silent-since-failed-respawn",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "EI-25326436725537582"
        ],
        "stopReason": "stalled-loops-guard (WI-6639): turns-stalled: 5 fire(s), last fired 2026-10-08T00:07:01.177Z, last turn 2026-10-07T23:32:26.855Z",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "warm",
        "witnessAt": "2026-10-10 02:18:43.429+00",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [
          "35075232"
        ],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-59826d83-3b3c-4029-b504-536ae91f45dc",
      "candidateReason": "native-error",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "EI-25230909916767391"
        ],
        "stopReason": "stalled-loops-guard (WI-6639): turns-stalled: 13 fire(s), last fired 2026-10-06T19:12:02.756Z, last turn 2026-10-06T17:34:10.518Z",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "warm",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-5e26d68f-60b7-4d7c-b1b7-0dbf07bcc96d",
      "candidateReason": "silent-since-failed-respawn",
      "frozenClaimCount": 7,
      "frozenParkedOn": [
        "conversation:answered:conv-mv0zk7hz-0000-7be9532702434fa09ec7d9ab2ad15381"
      ],
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": null,
      "ambiguousWorkedByItemRefs": [
        "EI-25459872006486989",
        "EI-25469506781920771",
        "EI-25473220875636506",
        "EI-25474602282386009",
        "EI-25476956079640843",
        "EI-25478414513699553",
        "EI-25480407075797097",
        "EI-25485784989152061",
        "EI-25488453011296230",
        "EI-25489164023826209",
        "EI-25493436056846904",
        "EI-25495930980805557",
        "EI-25500899958415779",
        "EI-25501311810844329",
        "EI-25501965727893345",
        "EI-25509780289449402",
        "WI-10007645",
        "WI-10007648",
        "WI-10007653",
        "WI-10007672",
        "WI-10007673",
        "WI-10007674",
        "WI-10007675",
        "WI-10007676",
        "WI-10007677",
        "WI-10007678",
        "WI-10007679"
      ],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-six-cutoff-wait-evidence-fire30-424d5.json",
        "assessment": {
          "status": "eligible-source-supported",
          "reason": "The pending R17 answer controls the disclosure correction and one targeted check. A separately owned endpoint incident has an explicit read-only causal investigation next step that does not require that answer; its original root cause remains unmeasured even after endpoint recovery. The final whole-lane freeze is agent-authored and cannot widen the typed step-specific owner wall. Original final read verifies six open/self-owned items; post-cutoff force-release supports the incident custody.",
          "scopeLimit": "No instruction here clears R17, reruns proof, edits source, enters LIVE_GATE_OPS, or changes another session. Eligibility source support remains separate from route continuity and outcome joins."
        },
        "evidence": [
          {
            "source": "/home/marsh-office/.papercusp/su-codex-homes/session-38370/sessions/2026/10/09/rollout-2026-10-09T19-05-22-01a122e9-fbb7-77d2-9452-71e6d6b33def.jsonl",
            "line": 558,
            "timestamp": "2026-10-10T03:52:28.934Z",
            "lineSha256": "476eca32940e487d89d00f312b6aa9fb68f6660292dbc66f726bf00550b788e2",
            "text": "Avi, I replied RETAIN and saved all six checkpoints. Session recovery is queued. Your R-17 decision remains pending; checks stay frozen and the plan remains unshipped."
          },
          {
            "source": "/home/marsh-office/.papercusp/su-codex-homes/session-38370/sessions/2026/10/09/rollout-2026-10-09T19-05-22-01a122e9-fbb7-77d2-9452-71e6d6b33def.jsonl",
            "line": 536,
            "timestamp": "2026-10-10T03:51:48.143Z",
            "lineSha256": "fb78529208b608f033a97660b3349b8507e5873734cb73243c8dc4fdc00a6725",
            "callId": "call_UZPnLLJF0NkbFBemeotqJGhU",
            "input": "function body(r){\n if(r.structuredContent)return r.structuredContent;\n for(const c of r.content??[])if(c.type===\"text\"){\n  try{return JSON.parse(c.text);}catch{}\n  const start=c.text.indexOf('{\\n  \"ok\"');if(start>=0){try{return JSON.parse(c.text.slice(start,c.text.lastIndexOf(\"}\")+1));}catch{}}\n }\n throw new Error(\"Expected JSON result\");\n}\nconst reply=body(await tools.mcp__papercusp_su__coord_send({\n to:[\"su-4ccd0992-d5b9-4994-99a4-f607429d7598\"],harness:\"papercusp\",expects:\"none\",\n related_msg_id:\"coord-send-483caff96dbd7457320c14a31dcd58eb77ab76516afbabb175f315706c63924b\",\n summary:\"bulk-d66686b8-8389-43bd-8879-6f7327d90fff: RETAIN sole R17 owner wall; no terminal option recommended\",\n body:[{text:\"RETAIN owner-wall:loop-carry-note:su-5e26d68f-60b7-4d7c-b1b7-0dbf07bcc96d. Live conversations:get confirms conv-mv0zk7hz-0000-7be9532702434fa09ec7d9ab2ad15381 remains open, accepted_answer:null, posts:[]. R17 disclosure correction plus one targeted check still await Avi's existing decision. Dismiss would clear an unresolved owner gate. Original proof and await255713 retained; no checks, edits, grading, delegation or LIVE_GATE_OPS.\",\n premises:[\"conversations:get current read of conv-mv0zk7hz-0000-7be9532702434fa09ec7d9ab2ad15381\"],\n forYouBecause:{relation:\"other\",note:\"You requested this guarded bulk-review recommendation.\"}}]\n}));\ntext(reply);\nconst sent=reply.results?.find(r=>r.ok);\nif(!sent||sent.bodyDeliveredChars!==sent.bodyFullChars)throw new Error(\"Full reply delivery not verified\");\nconst read=load(\"current_review_items\");\nif(read?.results?.length!==6||read.results.some(r=>!r.ok||r.workItem?.assignee!==\"su-5e26d68f-60b7-4d7c-b1b7-0dbf07bcc96d\"))throw new Error(\"Current claims differ\");\nconst updated=body(await tools.mcp__papercusp_su__work_items_checkpoint({items:read.results.map(r=>r.id===\"WI-10007679\"?{\n id:r.id,harness:\"papercusp\",append:true,\n checkpoint:\"2026-10-10T03:51Z bulk-d66686b8-8389-43bd-8879-6f7327d90fff answered RETAIN via \"+sent.msg_id+\"; full\"+sent.bodyDeliveredChars+\"char delivery verified. R17 live question open/no answer/posts. Original proof and pre-grading diagnostic preserved; no checks, edits, grading, delegation or gate operations. Clean boundary for managed recovery.\"\n }:{id:r.id,harness:\"papercusp\",unchanged:true,contentHash:r.checkpointContentHash})}));\ntext({phase:\"refresh\",counts:updated.counts,results:updated.results?.map(r=>({id:r.id,ok:r.ok,contentHash:r.contentHash,attested:r.attested,error:r.error,errorCode:r.errorCode}))});\nlet failed=[];\nfor(const r of updated.results??[])if(!r.ok){\n if(r.id===\"WI-10007679\"){failed.push(r);continue;}\n const fresh=body(await tools.mcp__papercusp_su__work_items_checkpoint({\n id:r.id,harness:\"papercusp\",append:true,\n checkpoint:\"2026-10-10T03:51Z continuity: current authoritative read confirms open/self-owned. Historical runtime observations remain unverified for current runtime; no fix/completion claim. Latest bulk request answered RETAIN; R17 question remains open/no answer/posts. Preserve existing answer await and original proof. No checks, edits, grading, delegation or LIVE_GATE_OPS. Clean boundary for managed recovery.\"\n }));\n text({phase:\"fresh_continuity\",id:r.id,result:fresh});\n if(fresh.counts?.failed)failed.push(r);\n}\nif(failed.length){store(\"current_review_checkpoint_failures\",failed);exit();}\nconst hash=updated.results.find(r=>r.id===\"WI-10007679\")?.contentHash;\nstore(\"compaction_main_hash\",hash);\ntext(await tools.mcp__papercusp_su__loop_checkpoint({\n harness:\"papercusp\",\n did:\"New bulk-d66686b8-8389-43bd-8879-6f7327d90fff answered RETAIN once via \"+sent.msg_id+\"; full\"+sent.bodyDeliveredChars+\"char delivery verified. R17 current question open/no answer/posts. All6 self/open checkpoints refreshed; main \"+hash+\" preserves pre-grading diagnostic/proof and handled review history. No tests, edits, grading, gate ops, delegation or runtime-fix claims.\",\n left:\"NOT SHIPPED. R15 deployed proof and retained pre-grading source adequacy/freshness diagnostic unresolved. R17 correction and one targeted operational check await Avi's existing answer. Original20956234/20954266 retained. Other5 incidents remain open with historical unverified runtime observations.\",\n next:\"Request managed compaction at this clean boundary, then settle on existing answer await255713. Successor verifies coord:whoami; uses complete matching recovery/CTRL without re-orient; uses fresh telemetry. Continue only on explicit Avi answer or materially new directed evidence. No polling loop, tests/cert reruns, artifact/spec/source edits, grader request, LIVE_GATE_OPS or delegation. Do not redo any handled Bulk reply.\",\n walls:[{key:\"r17-one-new-check-owner-choice\",claim:\"Already asked Avi and awaiting his answer: R17 disclosure correction and one targeted check remain owner-gated; current live question open/no answer/posts.\",recheck:\"conversations:get id conv-mv0zk7hz-0000-7be9532702434fa09ec7d9ab2ad15381\"}]\n}));\n"
          },
          {
            "source": "/home/marsh-office/.papercusp/su-codex-homes/session-38370/sessions/2026/10/09/rollout-2026-10-09T09-23-32-01a120d5-4be3-74b1-a2e4-837c8d556d89.jsonl",
            "line": 492,
            "timestamp": "2026-10-09T13:54:49.962Z",
            "lineSha256": "ced31764d3ee6a6fb9566b38ea7e42428230133625cd5679cedc4b2a44cb48fe",
            "item": "EI-25509780289449402",
            "left": "Root cause remains unmeasured. No RAM/CPU/disk or restart cause asserted. Suspected outage class remains ownedself; do not close from endpoint recovery alone. Main P008 no longer waits for this runtime.",
            "next": "Use retained transition timestamps and bounded runtime-owner logs to distinguish planned rotation from failed startup/listener recovery. Reuse existing service/runtime surfaces. Guard and durable fix require source authorization outside current edit/test freeze; retain this item and causal evidence until then. No LIVE_GATE_OPS."
          }
        ],
        "limit": "Existing supplemental source support; does not freeze whole116 membership or certify cutoff route continuity"
      },
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "warm",
        "witnessAt": "2026-10-09 00:57:15.129+00",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [
          "34304640",
          "34305153",
          "34334147",
          "34363632",
          "34389076",
          "34412748",
          "34441435",
          "34441974",
          "34461820",
          "34499783",
          "34500621",
          "34504848",
          "34516007",
          "34524064",
          "34533050",
          "34539920",
          "34549875",
          "34555693",
          "34555911",
          "34556762",
          "34566186",
          "34574808",
          "34583040",
          "34591973",
          "34598471",
          "34599054",
          "34609393",
          "34617515",
          "34626543",
          "34626828",
          "34627964",
          "34636153",
          "34645040",
          "34646179",
          "34654642",
          "34654981",
          "34664794",
          "34675131",
          "34691326",
          "34789159",
          "34977998",
          "35117641"
        ],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Preserve existing source assessment; verify exact cutoff assignment/control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-61f9729d-fef8-416a-88a8-72293cce5695",
      "candidateReason": "silent-since-failed-respawn",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "WI-10006388"
        ],
        "stopReason": "",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "cold",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-625df130-d2ce-4aef-badb-9e68b6ee51d4",
      "candidateReason": "native-error",
      "frozenClaimCount": 1,
      "frozenParkedOn": [
        "coord:inbox-wake:su-625df130-d2ce-4aef-badb-9e68b6ee51d4"
      ],
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "justified-scoped-wait",
        "workRefs": [
          "WI-10005639"
        ],
        "stopReason": "Blocked on P-012 bake-free event; exact-key await 226976 is registered, so ending the 60s loop avoids redundant polling while the declared event is pending.",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "warm",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-63bb4991-a409-47dc-afd4-b4616d64c73d",
      "candidateReason": "native-error",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "EI-25238060426364183"
        ],
        "stopReason": "stalled-loops-guard (WI-6639): turns-stalled: 12 fire(s), last fired 2026-10-06T17:58:30.787Z, last turn 2026-10-06T16:57:08.745Z",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "warm",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-684c584a-3351-49ee-a145-f657d7e42237",
      "candidateReason": "native-error",
      "frozenClaimCount": 3,
      "frozenParkedOn": [
        "work-item:unblocked:WI-10007106",
        "work-item:done:WI-10007305",
        "work-item:claimable",
        "coord:inbox-wake:su-684c584a-3351-49ee-a145-f657d7e42237"
      ],
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "justified-owner-pause",
        "workRefs": [
          "EI-25327682039407935",
          "EI-25380637492003672",
          "WI-10007106"
        ],
        "stopReason": "stalled-loops-guard (WI-6639): turns-stalled: 26 fire(s), last fired 2026-10-08T16:07:43.142Z, last turn 2026-10-08T15:17:34.670Z",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "warm",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-69e1022f-5619-4c52-aead-87d926c1b432",
      "candidateReason": "native-error",
      "frozenClaimCount": 2,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "WI-10006670",
          "EI-25220108914091418"
        ],
        "stopReason": "stalled-loops-guard (WI-6639): turns-stalled: 39 fire(s), last fired 2026-10-06T16:50:03.268Z, last turn 2026-10-06T14:49:08.123Z",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "cold",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-6b620d7a-a070-4ecc-a63c-1c81ffc321af",
      "candidateReason": "silent-since-failed-respawn",
      "frozenClaimCount": 3,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "EI-24734617138234222"
        ],
        "stopReason": "stalled-loops-guard (WI-6639): turns-stalled: 33 fire(s), last fired 2026-10-07T23:00:36.726Z, last turn 2026-10-07T22:08:45.614Z",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "cold",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-6e3cb6d4-4014-41ae-81ce-6305bc7d6a41",
      "candidateReason": "silent-since-failed-respawn",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "EI-24369812348196486"
        ],
        "stopReason": "stalled-loops-guard (WI-6639): turns-stalled: 12 fire(s), last fired 2026-10-07T21:45:46.580Z, last turn 2026-10-07T21:03:47.131Z",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "cold",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-6e8d0b9f-cdc3-4c53-806f-d187a0016e5e",
      "candidateReason": "native-error",
      "frozenClaimCount": 2,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "EI-25193645694463623",
          "EI-25203437570102456"
        ],
        "stopReason": "Blocked on the active papercusp git-sync run; event await 230516 is the intended wake. End the 60-second loop to avoid duplicate polling.",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "cold",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-704f5a66-5e60-4adf-8044-c45a75cfd9d8",
      "candidateReason": "native-error",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "justified-scoped-wait",
        "workRefs": [
          "EI-24897783670491563"
        ],
        "stopReason": "stalled-loops-guard (WI-6639): turns-stalled: 14 fire(s), last fired 2026-10-06T21:04:03.193Z, last turn 2026-10-06T19:56:10.901Z",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "warm",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-70fcd6a0-d71e-469e-af2c-3f9faa51679b",
      "candidateReason": "silent-since-failed-respawn",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "EI-25353616944888427"
        ],
        "stopReason": "stalled-loops-guard (WI-6639): turns-stalled: 9 fire(s), last fired 2026-10-08T00:04:02.013Z, last turn 2026-10-07T22:41:59.339Z",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "warm",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-72f78fbb-7e47-41ae-a842-35c83b8fcdd2",
      "candidateReason": "native-error",
      "frozenClaimCount": 2,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "WI-10006285",
          "WI-10006267"
        ],
        "stopReason": "stalled-loops-guard (WI-6639): turns-stalled: 91 fire(s), last fired 2026-10-07T20:55:31.871Z, last turn 2026-10-07T19:50:57.840Z",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "warm",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-7449fcf0-768a-43a5-8d3f-5ab55604ac4c",
      "candidateReason": "native-error",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "EI-25237971414928998"
        ],
        "stopReason": "stalled-loops-guard (WI-6639): turns-stalled: 10 fire(s), last fired 2026-10-06T17:58:30.791Z, last turn 2026-10-06T17:11:48.025Z",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "warm",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
      "candidateReason": "silent-since-failed-respawn",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": null,
      "ambiguousWorkedByItemRefs": [
        "EI-24732759761361262",
        "EI-24799587339942649",
        "EI-25162387718018046",
        "EI-25167213528609110",
        "EI-25339519848359808",
        "EI-25431048158144144",
        "EI-25510047405701253",
        "EI-25519488629645865",
        "EI-25526237895037819",
        "EI-25526739978478647",
        "EI-25531089562001145",
        "EI-25532836303285911",
        "EI-25535996069015190",
        "EI-25549785090361125"
      ],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "cold",
        "witnessAt": "2026-10-09 18:25:44.655+00",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [
          "34826106",
          "34836688",
          "34855337",
          "34882439",
          "34897845",
          "34924375",
          "34938104",
          "34962872",
          "34975894",
          "34988920",
          "34996602",
          "35006152",
          "35015509",
          "35020967",
          "35030923",
          "35059682",
          "35060092"
        ],
        "accepted": false
      },
      "originalReceiptReferences": [
        {
          "requestId": "34826106",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "34975894",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "34988920",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "35015509",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "35020967",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "35059682",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "35060092",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "34836688",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "34855337",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "34882439",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "34897845",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "34924375",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "34938104",
          "receiptState": "unresolved",
          "acceptedUnique": false,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "34962872",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "34996602",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "35006152",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "35030923",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        }
      ],
      "missingFullOriginalSources": [
        {
          "requestId": "34938104",
          "nativeIds": [
            "01a1228c-7bc5-76c2-ac09-038120bb49b5"
          ],
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold32-existing-original24-custody-and-native-frame-review-v2-424d5.json",
          "sourceLossProven": false
        }
      ],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-7ac2753d-7d1d-4fd5-9a4a-e115e91d6aaf",
      "candidateReason": "native-error",
      "frozenClaimCount": 4,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "EI-24958944483532851",
          "EI-25218925651069329",
          "WI-10005109"
        ],
        "stopReason": "Blocked on the progressing Papercusp git-sync fire; release event 233861 is the next wake source.",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "cold",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-7ec704fa-dc6a-4965-bb37-13576272127a",
      "candidateReason": "native-error",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "EI-25243192295257437"
        ],
        "stopReason": "stalled-loops-guard (WI-6639): turns-stalled: 15 fire(s), last fired 2026-10-06T18:00:38.267Z, last turn 2026-10-06T17:12:57.397Z",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "warm",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-80a51f05-4c07-4259-a883-8b9ef4b2a7ca",
      "candidateReason": "native-error",
      "frozenClaimCount": 3,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "justified-idle-or-handoff",
        "workRefs": [],
        "stopReason": "The source lane is genuinely blocked by the 3/3 concurrent-claim cap before lane evaluation. All three diagnostic claims are retained. The current fleet leader acknowledged the cap request and is actively checking governing constraints; stop empty pull wakes and resume on that directed ruling. Canonical carry7b6c58cb0970 preserves five loop checks, three separate historical item checks, D-002/sixunknowns/FAIL-L4 and final/native/BG/gate/deploy stops. No pending exec or lock.",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "warm",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-812af642-19bb-41ea-ba19-e20458d5759f",
      "candidateReason": "native-error",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "EI-25225672179870571"
        ],
        "stopReason": "stalled-loops-guard (WI-6639): turns-stalled: 11 fire(s), last fired 2026-10-06T17:58:30.795Z, last turn 2026-10-06T16:57:10.631Z",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "warm",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-82c46308-5eb9-4237-9d2d-950d322576c4",
      "candidateReason": "silent-since-failed-respawn",
      "frozenClaimCount": 2,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": null,
      "ambiguousWorkedByItemRefs": [
        "EI-21100326440153546",
        "EI-25292538496471009",
        "EI-25339497913821856",
        "EI-25409237207330047",
        "EI-25420372352055746",
        "EI-25424155808566263",
        "EI-25435626316100952",
        "EI-25491956221731239",
        "EI-25493088762182367",
        "EI-25525324492586126",
        "WI-10007742",
        "WI-10007746"
      ],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "cold",
        "witnessAt": "2026-10-09 20:16:13.818+00",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [
          "34896168"
        ],
        "compactionRequestIds": [
          "34886663",
          "34951697",
          "34967591",
          "34979247",
          "35018210",
          "35038308"
        ],
        "accepted": false
      },
      "originalReceiptReferences": [
        {
          "requestId": "34951697",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "34886663",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "34967591",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "34979247",
          "receiptState": "unresolved",
          "acceptedUnique": false,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "35018210",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "35038308",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        }
      ],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [
        {
          "requestId": "34979247",
          "owner": "EI-25879870290163805",
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold32-existing-original24-custody-and-native-frame-review-v2-424d5.json",
          "receiptAccepted": false
        }
      ],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-86cd7f0e-8929-469b-af96-e7ff9ead8e01",
      "candidateReason": "native-error",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "EI-25243018488749661"
        ],
        "stopReason": "stalled-loops-guard (WI-6639): turns-stalled: 10 fire(s), last fired 2026-10-06T17:59:01.578Z, last turn 2026-10-06T16:55:25.316Z",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "warm",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-8d2cb6cc-8f27-4a25-8541-b00927471b94",
      "candidateReason": "silent-since-failed-respawn",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": null,
      "ambiguousWorkedByItemRefs": [
        "EI-25405882696245541",
        "EI-25559198077114012"
      ],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "cold",
        "witnessAt": "2026-10-10 03:26:03.2+00",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [
          "35133707"
        ],
        "accepted": false
      },
      "originalReceiptReferences": [
        {
          "requestId": "35133707",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        }
      ],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-928e075d-6320-4ecf-9149-8c86187a9ed8",
      "candidateReason": "native-error",
      "frozenClaimCount": 2,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "justified-scoped-wait",
        "workRefs": [
          "WI-10006304",
          "WI-10006759"
        ],
        "stopReason": "stalled-loops-guard (WI-6639): turns-stalled: 129 fire(s), last fired 2026-10-08T00:02:42.466Z, last turn 2026-10-07T20:03:56.727Z",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "warm",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-960a52e7-9b11-42ac-8fe9-7e5e7e0da441",
      "candidateReason": "silent-since-failed-respawn",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": null,
      "ambiguousWorkedByItemRefs": [
        "EI-23690141614893238",
        "EI-25392760794406844",
        "EI-25522606742920561",
        "EI-25526814930223643",
        "EI-25531288541106334",
        "EI-25534758263003459",
        "EI-25535047319090973",
        "EI-25537137424151529",
        "EI-25547073030018889"
      ],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "cold",
        "witnessAt": "2026-10-10 00:17:12.298+00",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [
          "35014709",
          "35023582",
          "35045222"
        ],
        "accepted": false
      },
      "originalReceiptReferences": [
        {
          "requestId": "35014709",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "35023582",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "35045222",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        }
      ],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-9844199a-9ccd-4c7b-a47c-03bea510ee31",
      "candidateReason": "native-error",
      "frozenClaimCount": 2,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "EI-22624497244505100",
          "WI-10005599"
        ],
        "stopReason": "stalled-loops-guard (WI-6639): turns-stalled: 72 fire(s), last fired 2026-10-06T18:07:03.955Z, last turn 2026-10-06T17:33:57.934Z",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "cold",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-990b747e-c51f-482f-bf3d-8ffaa2b9ec34",
      "candidateReason": "native-error",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "EI-25249711154901592"
        ],
        "stopReason": "stalled-loops-guard (WI-6639): turns-stalled: 57 fire(s), last fired 2026-10-06T17:50:31.716Z, last turn 2026-10-06T17:18:59.936Z",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "cold",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-9b0d7528-da21-48ce-92a6-c98ca8c4777e",
      "candidateReason": "silent-since-failed-respawn",
      "frozenClaimCount": 2,
      "frozenParkedOn": [
        "work-item:unblocked:WI-10006770"
      ],
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "WI-10007462"
        ],
        "stopReason": "Blocked on the leader-owned WI-10007462 route item; one-shot completion await 246892 is registered.",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "cold",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-9d2295e7-3ce3-4776-a70e-21d3adb8b0a5",
      "candidateReason": "native-error",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "WI-10006761"
        ],
        "stopReason": "stalled-loops-guard (WI-6639): turns-stalled: 6 fire(s), last fired 2026-10-06T20:12:01.693Z, last turn 2026-10-06T19:41:03.420Z",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "warm",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-a0207b03-ccc8-43e2-8830-e47a09f36573",
      "candidateReason": "native-error",
      "frozenClaimCount": 1,
      "frozenParkedOn": [
        "coord:inbox-wake:su-a0207b03-ccc8-43e2-8830-e47a09f36573"
      ],
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "justified-scoped-wait",
        "workRefs": [
          "EI-25209690807142935"
        ],
        "stopReason": "EI-25209690807142935 is blocked: the leader confirms the required runtime tuple is unavailable and will carry the comparison as unmeasured. The item remains open; no source change, gate intervention, or new runner is warranted. Resume on a new inbox wake with concrete evidence or direction.",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "cold",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-a1cfa7fb-6d21-4bf0-b4aa-7482a73212a7",
      "candidateReason": "native-error",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "EI-25239280851552930"
        ],
        "stopReason": "stalled-loops-guard (WI-6639): turns-stalled: 8 fire(s), last fired 2026-10-06T17:58:30.857Z, last turn 2026-10-06T16:48:26.138Z",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "warm",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-a8d3f4c4-6268-47bb-9b42-c2a653e75e9f",
      "candidateReason": "silent-since-failed-respawn",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "EI-25418319205863242"
        ],
        "stopReason": "stalled-loops-guard (WI-6639): turns-stalled: 14 fire(s), last fired 2026-10-09T05:07:05.407Z, last turn 2026-10-08T20:57:15.798Z",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "warm",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-a969f93a-6e0b-4c86-a1c0-a5cf3283af8f",
      "candidateReason": "silent-since-failed-respawn",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "EI-24280747874516778"
        ],
        "stopReason": "stalled-loops-guard (WI-6639): turns-stalled: 11 fire(s), last fired 2026-10-08T01:58:07.885Z, last turn 2026-10-07T21:38:28.364Z",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "warm",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-a9a7a6ab-7edf-458a-9c3c-36ea9879c965",
      "candidateReason": "silent-since-failed-respawn",
      "frozenClaimCount": 0,
      "frozenParkedOn": [
        "work-item:claimable"
      ],
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": null,
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-six-cutoff-wait-evidence-fire30-424d5.json",
        "assessment": {
          "status": "excluded-source-supported-admission-hold",
          "reason": "Positive 13:47:57Z source states D008/D011 admission HOLD; ordinary claimable requeue did not release it. Historical observed COLD versus original WARM remains a separate root933 violation."
        },
        "evidence": [
          {
            "sourceRef": "session_turn:codex:01a1260b-2fb4-79f0-8b11-37151bafec03:41",
            "timestamp": "2026-10-10 13:47:19.94+00",
            "text": "This is another ordinary feature requeue. The admission HOLD still blocks pulls; I’ll check for new instructions and record the hint.\n",
            "textSha256": "7fd56bc109727e0321f3015acaa501da79050744b616fa8d760bd4244b919bc3",
            "sourceLimit": "retained indexed part, not a native call-id binding"
          },
          {
            "sourceRef": "session_turn:codex:01a1260b-2fb4-79f0-8b11-37151bafec03:46",
            "timestamp": "2026-10-10 13:47:57.75+00",
            "text": "Recorded the requeue hint and verified the checkpoint. D008/D011 HOLD remains; no work was pulled or claimed. Existing evidence and continuation settings are preserved.",
            "textSha256": "6cba54f97755e386bea7300c9b6969a4c91d05097285c9a4104ab40286042f18",
            "sourceLimit": "retained indexed part, not a native call-id binding"
          }
        ],
        "limit": "Existing supplemental source support; does not freeze whole116 membership or certify cutoff route continuity"
      },
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "warm",
        "witnessAt": "2026-10-08 02:22:58.281+00",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [
          "35163009",
          "35272600"
        ],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Preserve existing source assessment; verify exact cutoff assignment/control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-ab8cc07f-e903-4467-ac45-a32149258170",
      "candidateReason": "silent-since-failed-respawn",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": null,
      "ambiguousWorkedByItemRefs": [
        "EI-24857610896220695",
        "EI-25292538496471009",
        "EI-25319303910010271",
        "EI-25517079049726273",
        "EI-25517929398980998",
        "EI-25519837153758515",
        "EI-25521785505149415",
        "EI-25526426284384525",
        "EI-25536526228527384",
        "EI-25537850188472316",
        "WI-10007323"
      ],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "cold",
        "witnessAt": "2026-10-09 17:45:47.12+00",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [
          "34805876",
          "34817497",
          "34831365",
          "34840615",
          "34866872",
          "34888135",
          "34911877",
          "35031313",
          "35044097",
          "35050968"
        ],
        "accepted": false
      },
      "originalReceiptReferences": [
        {
          "requestId": "34817497",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "35050968",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "34805876",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "34831365",
          "receiptState": "unresolved",
          "acceptedUnique": false,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "34840615",
          "receiptState": "unresolved",
          "acceptedUnique": false,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "34866872",
          "receiptState": "unresolved",
          "acceptedUnique": false,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "34888135",
          "receiptState": "unresolved",
          "acceptedUnique": false,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "34911877",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "35031313",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "35044097",
          "receiptState": "unresolved",
          "acceptedUnique": false,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        }
      ],
      "missingFullOriginalSources": [
        {
          "requestId": "34831365",
          "nativeIds": [
            "01a121dd-4682-7970-a877-d48365ae96af",
            "01a121f3-2211-7912-b4f6-78fd26b41ca4"
          ],
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold32-existing-original24-custody-and-native-frame-review-v2-424d5.json",
          "sourceLossProven": false
        },
        {
          "requestId": "34840615",
          "nativeIds": [
            "01a121f3-2211-7912-b4f6-78fd26b41ca4"
          ],
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold32-existing-original24-custody-and-native-frame-review-v2-424d5.json",
          "sourceLossProven": false
        },
        {
          "requestId": "34866872",
          "nativeIds": [
            "01a12215-f913-74d0-8930-463399a84938"
          ],
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold32-existing-original24-custody-and-native-frame-review-v2-424d5.json",
          "sourceLossProven": false
        },
        {
          "requestId": "34888135",
          "nativeIds": [
            "01a12236-1107-7490-8034-f4da1c37b581",
            "01a12254-3c2e-7f12-abef-2dfea70788c5"
          ],
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold32-existing-original24-custody-and-native-frame-review-v2-424d5.json",
          "sourceLossProven": false
        }
      ],
      "retainedUnacceptedNativeFrames": [
        {
          "requestId": "35044097",
          "owner": "EI-25879870290163805",
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold32-existing-original24-custody-and-native-frame-review-v2-424d5.json",
          "receiptAccepted": false
        }
      ],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
      "candidateReason": "silent-since-failed-respawn",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": null,
      "ambiguousWorkedByItemRefs": [
        "EI-24834539975782402",
        "EI-25440463495123481",
        "EI-25521146595079212",
        "EI-25524116857732713",
        "EI-25525763915350862",
        "EI-25529147182722319",
        "EI-25530348747386165",
        "EI-25530823393475480",
        "EI-25532831416704436",
        "EI-25535444486879942",
        "EI-25536986894028197",
        "EI-25537234969663449",
        "EI-25545490305036905"
      ],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "cold",
        "witnessAt": "2026-10-09 18:30:18.913+00",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [
          "34828463",
          "34932173",
          "34941445",
          "34951995",
          "34980537",
          "34992385",
          "35002236",
          "35003363",
          "35012964",
          "35013188",
          "35013284",
          "35022684",
          "35038763",
          "35050614"
        ],
        "accepted": false
      },
      "originalReceiptReferences": [
        {
          "requestId": "34828463",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "34941445",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "34951995",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "34980537",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "35003363",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "35050614",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "34932173",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "34992385",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "35002236",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "35012964",
          "receiptState": "unresolved",
          "acceptedUnique": false,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "35013188",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "35013284",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "35022684",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "35038763",
          "receiptState": "unresolved",
          "acceptedUnique": false,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        }
      ],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [
        {
          "requestId": "35012964",
          "owner": "EI-25879870290163805",
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold32-existing-original24-custody-and-native-frame-review-v2-424d5.json",
          "receiptAccepted": false
        },
        {
          "requestId": "35038763",
          "owner": "EI-25879870290163805",
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold32-existing-original24-custody-and-native-frame-review-v2-424d5.json",
          "receiptAccepted": false
        }
      ],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-ad69d345-2a2e-44dc-91e1-82214609ff1a",
      "candidateReason": "native-error",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "EI-25243843951655191"
        ],
        "stopReason": "stalled-loops-guard (WI-6639): turns-stalled: 12 fire(s), last fired 2026-10-06T18:06:01.972Z, last turn 2026-10-06T17:30:34.824Z",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "warm",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-af19b8e7-8887-4ddf-9de9-705fd2a19071",
      "candidateReason": "native-error",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "justified-recorded-dependency",
        "workRefs": [
          "WI-10006322"
        ],
        "stopReason": "WI-10006322 is blocked on git-sync:committed; the live repair owner already awaits that event. The item and carry are checkpointed and the fleet leader has the current staging evidence.",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "cold",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-b24bba70-8532-4c3f-8894-8a098a016b31",
      "candidateReason": "native-error",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "EI-25242388550115331"
        ],
        "stopReason": "stalled-loops-guard (WI-6639): turns-stalled: 15 fire(s), last fired 2026-10-06T18:06:34.105Z, last turn 2026-10-06T17:11:54.362Z",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "warm",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-b4028e2d-590a-4d1c-9256-b44536574813",
      "candidateReason": "native-error",
      "frozenClaimCount": 6,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "justified-scoped-wait",
        "workRefs": [
          "EI-25302410770886637",
          "WI-10006910",
          "WI-10006997",
          "EI-25273722956357749",
          "EI-25287933876758243",
          "WI-10007191"
        ],
        "stopReason": "Bounded own-acceptance monitor reached second no-delta wake; switching from repeated status checks to reserved-auditor liveness diagnosis.",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "warm",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-b7ae044b-c702-4275-8857-d8c0943bc6f6",
      "candidateReason": "silent-since-failed-respawn",
      "frozenClaimCount": 0,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": null,
      "ambiguousWorkedByItemRefs": [
        "EI-25291938859310072",
        "EI-25394335063815313",
        "EI-25431020429534021",
        "EI-25556577096086238"
      ],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "cold",
        "witnessAt": "2026-10-10 00:58:16.474+00",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [
          "35045161",
          "35058458",
          "35104998"
        ],
        "accepted": false
      },
      "originalReceiptReferences": [
        {
          "requestId": "35104998",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "35045161",
          "receiptState": "unresolved",
          "acceptedUnique": false,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "35058458",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        }
      ],
      "missingFullOriginalSources": [
        {
          "requestId": "35045161",
          "nativeIds": [
            "01a1234d-de07-7972-bec8-6771e5714d38"
          ],
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold32-existing-original24-custody-and-native-frame-review-v2-424d5.json",
          "sourceLossProven": false
        }
      ],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-b83c1f62-d5f3-49a7-b59d-e38fa0ecf97d",
      "candidateReason": "silent-since-failed-respawn",
      "frozenClaimCount": 1,
      "frozenParkedOn": [
        "work-item:claimable"
      ],
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "EI-25350317231253835"
        ],
        "stopReason": "Fleet spec pull found zero claimable bugs; sent the floor evidence to the leader and registered a standing claimable-item wake watch.",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "warm",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-b90c2f86-5497-4fa0-ad9a-387132dc9730",
      "candidateReason": "native-error",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "WI-10005186"
        ],
        "stopReason": "stalled-loops-guard (WI-6639): turns-stalled: 20 fire(s), last fired 2026-10-06T18:03:02.727Z, last turn 2026-10-06T17:10:08.614Z",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "warm",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-b9ccbf0d-131b-4a64-aca3-90987d99d842",
      "candidateReason": "native-error",
      "frozenClaimCount": 3,
      "frozenParkedOn": [
        "work-item:done:WI-10006170",
        "work-item:unblocked:WI-10005952",
        "coord:inbox-wake:su-b9ccbf0d-131b-4a64-aca3-90987d99d842"
      ],
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "justified-recorded-dependency",
        "workRefs": [
          "WI-10005952"
        ],
        "stopReason": "P004 is dependency-only blocked pending the actual fleet-leader final-source-ready instruction/pin. Preserve the retained TEST seat and inbox event wake; stop periodic proof/source monitoring.",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "cold",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-ba80f2f7-46f6-4aec-b99a-21e02460933f",
      "candidateReason": "silent-since-failed-respawn",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": null,
      "ambiguousWorkedByItemRefs": [
        "EI-24371648636496583",
        "EI-25430105870893148",
        "EI-25527787356902783",
        "EI-25528523309275039",
        "EI-25529224320001460",
        "EI-25533389265608515",
        "EI-25537124974318727",
        "EI-25537646052753587",
        "EI-25543808075961682",
        "WI-10007541"
      ],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "cold",
        "witnessAt": "2026-10-09 20:38:47.049+00",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [
          "34901238",
          "34912704",
          "34925297",
          "34926174",
          "34980575",
          "34993138"
        ],
        "accepted": false
      },
      "originalReceiptReferences": [
        {
          "requestId": "34901238",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "34912704",
          "receiptState": "unresolved",
          "acceptedUnique": false,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "34925297",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "34926174",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "34980575",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "34993138",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        }
      ],
      "missingFullOriginalSources": [
        {
          "requestId": "34912704",
          "nativeIds": [
            "01a12266-3e63-7283-821f-8cbcd5c543fa"
          ],
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold32-existing-original24-custody-and-native-frame-review-v2-424d5.json",
          "sourceLossProven": false
        }
      ],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-bce4e498-fbb7-4457-acc3-1ae2215875e0",
      "candidateReason": "silent-since-failed-respawn",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "EI-25358390580913441"
        ],
        "stopReason": "stalled-loops-guard (WI-6639): turns-stalled: 4 fire(s), last fired 2026-10-07T23:59:01.163Z, last turn 2026-10-07T23:32:21.668Z",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "cold",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-bf22e2b4-9980-4a5b-9ec8-1ee8a4438e97",
      "candidateReason": "native-error",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "justified-scoped-wait",
        "workRefs": [
          "WI-10005691"
        ],
        "stopReason": "loop:end — deactivated by its owner",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "cold",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-c029e8fc-24ed-4ad8-8994-a003d2be60f6",
      "candidateReason": "silent-since-failed-respawn",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": null,
      "ambiguousWorkedByItemRefs": [
        "EI-24771538191031101",
        "EI-25216051885527605",
        "EI-25320301610018659",
        "EI-25467831823677377",
        "EI-25545725983966453",
        "EI-25550161346040174",
        "EI-25553930898461754",
        "EI-25554800280085355",
        "EI-25557194821958563",
        "EI-25561829281497032"
      ],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "warm",
        "witnessAt": "2026-10-10 03:27:38.972+00",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [
          "35107170",
          "35124531",
          "35145917"
        ],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-c7a48b7b-f8fd-4215-aa09-5fe6bebc007c",
      "candidateReason": "silent-since-failed-respawn",
      "frozenClaimCount": 9,
      "frozenParkedOn": [
        "work-item:unblocked:WI-10007666",
        "work-item:done:WI-10007665",
        "work-item:done:WI-10007663",
        "work-item:unblocked:WI-10007665",
        "work-item:done:WI-10007664",
        "work-item:unblocked:WI-10007663"
      ],
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": null,
      "ambiguousWorkedByItemRefs": [
        "EI-25470665474313948",
        "EI-25470910275946484",
        "EI-25477629026647979",
        "EI-25480990835286495",
        "EI-25483427979510528",
        "WI-10007638",
        "WI-10007643",
        "WI-10007662",
        "WI-10007663",
        "WI-10007664",
        "WI-10007665",
        "WI-10007666",
        "WI-10007667"
      ],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-six-cutoff-wait-evidence-fire30-424d5.json",
        "assessment": {
          "status": "eligible-source-supported",
          "reason": "A universal setup-only exclusion is falsified by separately owned WI-10007654 with a documented read-only next step independent of actual Slack/Asana inputs. Original open/self-owned read, original next-action source, nine-candidate archive, and post-cutoff force-release holder agree. Six setup/implementation roots do not extend their blocker to the unrelated attribution investigation.",
          "scopeLimit": "This is a source-supported eligibility assessment for the frozen owner; it does not certify continuous model/account/carry through cutoff, current holdings, a recovery outcome, or all nine candidates as actionable."
        },
        "evidence": [
          {
            "source": "/home/marsh-office/.papercusp/su-codex-homes/session-38321/sessions/2026/10/09/rollout-2026-10-09T23-56-35-01a123f4-9be3-7080-8df1-cd0ce2e8075b.jsonl",
            "line": 646,
            "timestamp": "2026-10-10T12:29:57.277Z",
            "lineSha256": "11a3122dc67d684890a647803a50da49480d8e7f00735b1b7d0747843a8aae96",
            "text": "Avi, the review is answered with retain recommendations for all four items. The successor brief is saved and compaction is queued. Setup inputs remain pending; the real drill is still unverified."
          },
          {
            "source": "/home/marsh-office/.papercusp/su-codex-homes/session-38321/sessions/2026/10/09/rollout-2026-10-09T23-56-35-01a123f4-9be3-7080-8df1-cd0ce2e8075b.jsonl",
            "line": 627,
            "timestamp": "2026-10-10T12:29:14.162Z",
            "lineSha256": "c30a02f5fcdd2d17fc4aaf9616ce5539dc11d6fa1c712c6cfffce8d4dc9ffd2a",
            "callId": "call_f458f9fceb0f4d44a70176595973c754",
            "input": "const sent=await tools.mcp__papercusp_su__coord_send({\n to:[\"su-6b8420e0-d367-4c97-90b8-b1fb14a60061\"],\n related_msg_id:\"coord-send-a3293768546d18a449041d8de6fdbe0cbdc226552d0917e8c63939db4a6f098b\",\n expects:\"none\",\n summary:\"My recommendation: retain all four items; no drop.\",\n body:[{text:\"My recommendations:\\nwork-item-blocked:WI-10007666 retain — real cross-stage drill awaits setup.\\nwork-item-blocked:WI-10007665 retain — real target/combined-PR/exact-merge verification awaits setup.\\nwork-item-blocked:WI-10007663 retain — real Asana provider verification awaits setup.\\nwork-item-blocked:WI-10007667 retain — existing storage recovery and pending Slack authentication/private Asana project inputs.\\nFresh WI67 is blocked/self-assigned; a959c295aecb and nextAction unchanged. I remain responsible; source proofs saved.\"}],\n harness:\"papercusp\",\n plan_slug:\"slack-asana-reproduced-bug-fix-pr-workflow-2026-10-08\"\n});\nconst t=sent.content?.find(c=>c.type===\"text\" && c.text.startsWith(\"{\"))?.text;\nconst receipt=t?JSON.parse(t):{};\ntext(receipt);\nif(receipt.ok!==true)exit();\nstore(\"compactionBoundaryReply\",receipt.results[0].msg_id);\nconst saved=await tools.mcp__papercusp_su__loop_checkpoint({\n harness:\"papercusp\",\n did:\"[turn:self] New review coord-send-a3293768546d18a449041d8de6fdbe0cbdc226552d0917e8c63939db4a6f098b reconciled as unanswered and replied via \"+receipt.results[0].msg_id+\" to su-6b8420e0-d367-4c97-90b8-b1fb14a60061. My per-item retain recommendations preserve exact work-item-blocked refs WI-10007666/65/63/67; no drop. All earlier bulk consultations in this continuation were answered/threaded; do not replay. Fresh WI67 resume remains blocked/self-assigned, a959c295aecb and explicit nextAction intact. Governing plan: slack-asana-reproduced-bug-fix-pr-workflow-2026-10-08, scope P004/P005/P006; use complete automatic recovery/current plan authority in successor. Logical owner identity remains su-c7a48b7b-f8fd-4215-aa09-5fe6bebc007c. Clean boundary before requested compaction: no further meaningful work will follow the compaction request.\",\n left:\"Actual storage recovery and actual pending Slack authentication/private Asana project input remain recorded dependencies; no review in this continuation supplied either. Completed builder, private upstream, narrow scope grant and P001-P005 source proofs remain saved on WI-10007662..67. Real model/agent/provider/combined-PR/exact-merge drill remains unverified. Runtime/target health and upstream baseline evidence are historical: preflight only after meaningful recovery. Related EI-25513044826743664, EI-25470665474313948 and EI-25483427979510528 were already done; do not reopen their source repair. EI-25542467890782167 was read earlier as open unassigned probation observation, not an adopted lane. No source edits, tests, file locks, root/global-gate operations, blind Git-sync retry, handled-mail replay or live native exec handles. Existing inbox/blocked-item wakes retain continuity; loop inactive.\",\n next:load(\"wi67LatestNextAction\").text\n});\nfor(const c of saved.content ?? [])if(c.type===\"text\" && c.text.startsWith(\"{\")){\n const p=JSON.parse(c.text);store(\"compactionBoundaryCheckpoint\",p);text(p);\n}\n"
          },
          {
            "source": "/home/marsh-office/.papercusp/su-codex-homes/session-38321/sessions/2026/10/08/rollout-2026-10-08T18-40-46-01a11dad-1bdc-7602-8fa3-3def556b7c92.jsonl",
            "line": 1138,
            "timestamp": "2026-10-09T00:50:04.849Z",
            "lineSha256": "e6897a0c9bc48f5121199a8e2f667257750a8b2db11c555a5b6c1a84cc915b91",
            "item": "WI-10007654",
            "left": "Still open: establish whether there is any remaining current-build enrollment defect. Related WI-10006568/WI-10007211 are done. A current-build checkpoint receipt now reports writtenDuring verdict owner-typed, so the old-runtime observation may be source/serving-generation skew rather than a new defect. Do not claim a root cause or edit provenance code without a distinguishing test.",
            "next": "After the directed workflow implementation has progressed, compare current-build transcript origin resolution and authenticated hook association for the exact same canonical turn refs against the old runtime. Read existing fixes and guard tests. Close as unconfirmed/expected behavior if no current defect is reproduced; otherwise preserve measured proof and own the durable fix. This follow-up must not divert the shipping workflow into a speculative authority change."
          },
          {
            "source": "/home/marsh-office/.papercusp/su-codex-homes/session-38321/sessions/2026/10/08/rollout-2026-10-08T22-40-33-01a11e88-a1fc-7971-ab6d-d5900b33d08d.jsonl",
            "line": 524,
            "timestamp": "2026-10-09T03:03:35.636Z",
            "lineSha256": "8c90fb1ad47e02ab8b0ea4e67ea3eddb94ed283adbf1272fae4924c955dc6d19",
            "item": "EI-25469175450310382",
            "next": "Reuse current-build :3170 for P006 source preparation. Preserve current code/test refs; coordinate existing release lane for eventual runtime update only as final shipment depends. Do not mutate/read the held gate. Verify later against exact shipped artifact before terminal closure."
          }
        ],
        "limit": "Existing supplemental source support; does not freeze whole116 membership or certify cutoff route continuity"
      },
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "warm",
        "witnessAt": "2026-10-09 00:15:39.91+00",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [
          "34299026",
          "34299464",
          "34312133",
          "34324569",
          "34331895",
          "34345535",
          "34360343",
          "34361159",
          "34378395",
          "34394498",
          "34407247",
          "34431276",
          "34451692",
          "34463291",
          "34472579",
          "34491338",
          "34587718",
          "34680072",
          "34681303",
          "34695228",
          "34712508",
          "34713901",
          "35119565",
          "35346666"
        ],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Preserve existing source assessment; verify exact cutoff assignment/control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-c832d9a7-6920-4550-9674-9cf05dcc513a",
      "candidateReason": "native-error",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "EI-25239124307821789"
        ],
        "stopReason": "stalled-loops-guard (WI-6639): turns-stalled: 11 fire(s), last fired 2026-10-06T17:55:33.464Z, last turn 2026-10-06T16:48:22.048Z",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "warm",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-cc7811cb-e5a2-4fba-aa88-82b8b0af286b",
      "candidateReason": "native-error",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "EI-25238313061023064"
        ],
        "stopReason": "stalled-loops-guard (WI-6639): turns-stalled: 12 fire(s), last fired 2026-10-06T19:12:02.747Z, last turn 2026-10-06T17:42:58.208Z",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "warm",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-cca022c6-abd0-481c-bac8-5b2515247196",
      "candidateReason": "native-error",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "EI-25253910623034390"
        ],
        "stopReason": "stalled-loops-guard (WI-6639): turns-stalled: 12 fire(s), last fired 2026-10-06T21:07:06.109Z, last turn 2026-10-06T19:56:17.285Z",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "warm",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-cf144a16-16f8-4e0b-9385-34a3c60a4c36",
      "candidateReason": "native-error",
      "frozenClaimCount": 3,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "EI-25234674994072047",
          "EI-24890753013901545"
        ],
        "stopReason": "stalled-loops-guard (WI-6639): turns-stalled: 62 fire(s), last fired 2026-10-06T17:07:03.290Z, last turn 2026-10-06T14:41:14.925Z",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "cold",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-d04734a3-55b6-4397-aa78-f94023423da4",
      "candidateReason": "silent-since-failed-respawn",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "EI-25379920754565767"
        ],
        "stopReason": "Blocked on the leader-owned git-sync-origin-fresh event. Await 248178 is the deliberate independent wake source; the leader is live and the active git-sync run is progressing, so no polling loop is needed.",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "cold",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-d3f260f3-10dd-410f-a483-64a8aa6d94f2",
      "candidateReason": "silent-since-failed-respawn",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "WI-10006971"
        ],
        "stopReason": "stalled-loops-guard (WI-6639): turns-stalled: 9 fire(s), last fired 2026-10-07T23:04:04.309Z, last turn 2026-10-07T21:42:20.124Z",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "warm",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-d589b5a0-2b4e-4413-a74a-430577e14cd5",
      "candidateReason": "native-error",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "justified-scoped-wait",
        "workRefs": [
          "WI-10005908"
        ],
        "stopReason": "Blocked on the fleet's peer-review floor: sampled spec-matched reviews are already revision-requested or held by peers; the one pending sample is assigned elsewhere. The harness-wide claim-next path is outside the bug-only claim spec. Fleet leader received the evidence; no awaitable review-status event family exists, so ending avoids empty queue polls.",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "warm",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-d759f7bc-0b18-43bd-8945-b839fa0e54c9",
      "candidateReason": "native-error",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "justified-owner-pause",
        "workRefs": [
          "WI-10007468"
        ],
        "stopReason": "stalled-loops-guard (WI-6639): turns-stalled: 19 fire(s), last fired 2026-10-08T18:13:32.603Z, last turn 2026-10-08T15:18:23.849Z",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "warm",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-d88420f0-c0b4-4dc7-92c7-f60ab3ddab44",
      "candidateReason": "silent-since-failed-respawn",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": null,
      "ambiguousWorkedByItemRefs": [
        "EI-23123046371584666",
        "EI-23232164292523291",
        "EI-23597878879756695",
        "EI-24385402235802839",
        "EI-25376635449301072",
        "EI-25403881334911643",
        "EI-25481493419888263",
        "EI-25510532929802527",
        "EI-25537764432133982",
        "EI-25538569685323911",
        "EI-25587892243108240",
        "WI-10008104"
      ],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "cold",
        "witnessAt": "2026-10-10 06:24:03.423+00",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [
          "35217653",
          "35232736",
          "35246481",
          "35271105",
          "35289337"
        ],
        "accepted": false
      },
      "originalReceiptReferences": [
        {
          "requestId": "35217653",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "35246481",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "35271105",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "35232736",
          "receiptState": "unresolved",
          "acceptedUnique": false,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "35289337",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        }
      ],
      "missingFullOriginalSources": [
        {
          "requestId": "35232736",
          "nativeIds": [
            "01a124bf-7bab-7351-93bf-9daa6283b81e"
          ],
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold32-existing-original24-custody-and-native-frame-review-v2-424d5.json",
          "sourceLossProven": false
        }
      ],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-ddac0f5b-1a6b-43fc-b881-754ab28175ee",
      "candidateReason": "native-error",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "EI-25221258731575502"
        ],
        "stopReason": "stalled-loops-guard (WI-6639): turns-stalled: 52 fire(s), last fired 2026-10-06T17:57:32.912Z, last turn 2026-10-06T14:48:19.517Z",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "cold",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-ddb4cbf4-2581-4f7c-8d6a-efbb712bd295",
      "candidateReason": "silent-since-failed-respawn",
      "frozenClaimCount": 2,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": null,
      "ambiguousWorkedByItemRefs": [
        "EI-25407594604362313",
        "EI-25410344016199089",
        "EI-25414574542257397",
        "EI-25416102294036031",
        "EI-25417029618030474",
        "EI-25432774600053142",
        "EI-25441632523386235",
        "EI-25443351537750113",
        "EI-25443757903549404",
        "EI-25447647386715388",
        "EI-25449528026030267",
        "EI-25462769978350914",
        "EI-25471239157480271",
        "EI-25472723840762151",
        "EI-25492589519483281",
        "EI-25495485988836164"
      ],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "cold",
        "witnessAt": "2026-10-09 21:52:52.005+00",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [
          "34967597",
          "34981473",
          "34994869",
          "34995559",
          "35005267",
          "35021734"
        ],
        "accepted": false
      },
      "originalReceiptReferences": [
        {
          "requestId": "34981473",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "34994869",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "35021734",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "34967597",
          "receiptState": "unresolved",
          "acceptedUnique": false,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "34995559",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "35005267",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        }
      ],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [
        {
          "requestId": "34967597",
          "owner": "EI-25879870290163805",
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold32-existing-original24-custody-and-native-frame-review-v2-424d5.json",
          "receiptAccepted": false
        }
      ],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-de5729a7-76d6-4498-8766-c084b2502a21",
      "candidateReason": "silent-since-failed-respawn",
      "frozenClaimCount": 1,
      "frozenParkedOn": [
        "conversation:answered:conv-mv1zojai-0000-a7cbdcca44e6414ebca278dca8e496c7"
      ],
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": null,
      "ambiguousWorkedByItemRefs": [
        "EI-22725265722838451",
        "EI-23241836994497967",
        "EI-24881462293464354",
        "EI-25181418726005405",
        "EI-25273951036116837",
        "EI-25557972974449028",
        "EI-25566869650575134"
      ],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-six-cutoff-wait-evidence-fire30-424d5.json",
        "assessment": {
          "status": "eligible-source-supported",
          "reason": "Original 06:56:10Z source records restored reachable psu-socket, guaranteed wake, leader pickup and owned structured closure still pending. Old no-host reason was positively falsified before cutoff; obsolete pending host question does not establish legitimate parking."
        },
        "evidence": [
          {
            "sourceRef": "session_turn:codex:01a12489-abcc-7ff3-b35a-a8a84157896e:90",
            "timestamp": "2026-10-10 06:54:45.891+00",
            "text": "The updated item checkpoint saved, but its provenance lint flagged the “revision notice posted” statement because it lacked a current-turn anchor. I’m fixing that, recording the recovered host in the cold carry note, then requesting compaction before taking on more work.",
            "textSha256": "97bfafb6e8697d524e071026b4de2ebba6a7e3e2f034eece74f60fc3985b9df7",
            "sourceLimit": "retained indexed part, not a native call-id binding"
          },
          {
            "sourceRef": "session_turn:codex:01a12489-abcc-7ff3-b35a-a8a84157896e:97",
            "timestamp": "2026-10-10 06:56:10.945+00",
            "text": "Fresh recovery confirmed the old host blocker is stale: the loop is active, `psu-socket` is reachable, and the next wake is guaranteed. The fleet leader is live and has the recovery update.\n\nFor [EI-25566869650575134](/home/marsh-office/papercupai-workspace/papercusp), source and live records match the expected 55-second nested timeout behavior: the target can continue and commit side effects after `request_timeout`. The review state and revision message are present; pickup by the parked submitter is unconfirmed. No code changed, and I did not run tests; I inspected the existing deadline test in [mcp-deadline.test.ts](/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/endpoint-route/routes/transport/__tests__/mcp-deadline.test.ts:89).\n\nThe item remains open and checkpointed for structured closure on the next wake. A compaction respawn is queued, not yet performed. The checkpoint tool still reported a provenance warning despite the self-turn marker, so the successor should verify the transcript evidence before closing.",
            "textSha256": "2764241d301c0e3cf268d71097e8abf0fb8db4d98c17eb4f16e4074f519ad508",
            "sourceLimit": "retained indexed part, not a native call-id binding"
          }
        ],
        "limit": "Existing supplemental source support; does not freeze whole116 membership or certify cutoff route continuity"
      },
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "cold",
        "witnessAt": "2026-10-10 05:53:09.939+00",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [
          "35200300"
        ],
        "accepted": false
      },
      "originalReceiptReferences": [
        {
          "requestId": "35200300",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        }
      ],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Preserve existing source assessment; verify exact cutoff assignment/control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-e29e77de-45ec-4677-b1b4-3b662ab57a95",
      "candidateReason": "silent-since-failed-respawn",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "EI-25420411002163456"
        ],
        "stopReason": "stalled-loops-guard (WI-6639): turns-stalled: 8 fire(s), last fired 2026-10-09T02:08:20.661Z, last turn 2026-10-08T22:22:21.425Z",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "warm",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-e2f4c8b8-3d4a-4f05-9607-d7de17e558f4",
      "candidateReason": "native-error",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "justified-scoped-wait",
        "workRefs": [
          "EI-25204351799939628"
        ],
        "stopReason": "D-042's single evidence unit is recorded and the leader has directed preserving the hold during independent review. No separate completion event is declared; end the periodic loop rather than monitor the live leader. Resume only if the leader sends a new source-grounded ruling and wakes this session.",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "cold",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-e72eb90d-23bb-4363-aaf7-72e4c693c881",
      "candidateReason": "silent-since-failed-respawn",
      "frozenClaimCount": 2,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "EI-25207598262592997",
          "EI-24937591709395249"
        ],
        "stopReason": "",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "cold",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-ec24b79e-fb5f-4056-847e-c1bd3edfec3a",
      "candidateReason": "silent-since-failed-respawn",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "justified-budget-or-time-bound",
        "workRefs": [
          "EI-25477838487191856"
        ],
        "stopReason": "dead-man guard: max-duration 1218s > 600s (since arm)",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "warm",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
      "candidateReason": "silent-since-failed-respawn",
      "frozenClaimCount": 2,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": null,
      "ambiguousWorkedByItemRefs": [
        "EI-21680130643090515",
        "EI-24753378000938390",
        "EI-25214204794544129",
        "EI-25218724287547707",
        "EI-25223755767814811",
        "EI-25249583591699815",
        "EI-25509315326499883",
        "EI-25535987029432879",
        "EI-25536780370261789",
        "EI-25539189639919346",
        "EI-25541385148400614",
        "WI-10007737",
        "WI-10007799"
      ],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "cold",
        "witnessAt": "2026-10-06 11:52:18.49+00",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [
          "32189831",
          "32205045",
          "32216380",
          "32231391",
          "32243511",
          "32259530",
          "32327156",
          "34925804",
          "34937571",
          "34964960",
          "34995729",
          "35007728",
          "35015047",
          "35035804",
          "35046373"
        ],
        "accepted": false
      },
      "originalReceiptReferences": [
        {
          "requestId": "32205045",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "32327156",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "34964960",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "34995729",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "35035804",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "35046373",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "32189831",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "32216380",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "32231391",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "32243511",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "32259530",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "34925804",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "34937571",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "35007728",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "35015047",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        }
      ],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-f5fc3980-cd07-43d9-8931-d48d75988a29",
      "candidateReason": "native-error",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "EI-25220422162112859"
        ],
        "stopReason": "stalled-loops-guard (WI-6639): turns-stalled: 57 fire(s), last fired 2026-10-06T17:42:01.635Z, last turn 2026-10-06T17:24:34.366Z",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "cold",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-f6b6fcca-f4f9-484f-86ca-974378824a67",
      "candidateReason": "silent-since-failed-respawn",
      "frozenClaimCount": 3,
      "frozenParkedOn": [
        "coord:inbox-wake:su-f6b6fcca-f4f9-484f-86ca-974378824a67"
      ],
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "justified-scoped-wait",
        "workRefs": [
          "EI-25406390778633427",
          "WI-10006713"
        ],
        "stopReason": "Blocked at the fleet claim cap (2/2) pending the registered leader's capacity ruling. The standing coord:inbox-wake await is the resumption path; stop the recurring work loop to avoid empty cap refusals.",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "cold",
        "witnessAt": "2026-10-10 03:09:50.929+00",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [
          "35099069",
          "35115120"
        ],
        "accepted": false
      },
      "originalReceiptReferences": [
        {
          "requestId": "35099069",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "35115120",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        }
      ],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-f6e9cbee-faee-465e-9281-2743f85a91ab",
      "candidateReason": "silent-since-failed-respawn",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": null,
      "ambiguousWorkedByItemRefs": [
        "EI-21100326440153546",
        "EI-21196080081716753",
        "EI-25516864794830903",
        "EI-25521118925191140",
        "EI-25529582368786254",
        "WI-10006552"
      ],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "cold",
        "witnessAt": "2026-10-10 02:05:39.736+00",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [
          "35069597",
          "35096877"
        ],
        "accepted": false
      },
      "originalReceiptReferences": [
        {
          "requestId": "35096877",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "35069597",
          "receiptState": "no-host-refused",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        }
      ],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-f943ed28-5fdf-4bb5-a258-7d7f814319d3",
      "candidateReason": "silent-since-failed-respawn",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "WI-10006830"
        ],
        "stopReason": "stalled-loops-guard (WI-6639): turns-stalled: 7 fire(s), last fired 2026-10-07T23:03:33.700Z, last turn 2026-10-07T22:05:21.282Z",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "warm",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-f9c6b250-0e9a-4fa8-85d3-0d6edf183297",
      "candidateReason": "native-error",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "WI-10006402"
        ],
        "stopReason": "stalled-loops-guard (WI-6639): turns-stalled: 11 fire(s), last fired 2026-10-06T17:59:01.599Z, last turn 2026-10-06T16:56:17.748Z",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "warm",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-faf26552-0633-4081-a250-172c02f07c19",
      "candidateReason": "silent-since-failed-respawn",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "EI-24833086093391569"
        ],
        "stopReason": "stalled-loops-guard (WI-6639): turns-stalled: 14 fire(s), last fired 2026-10-07T03:38:32.634Z, last turn 2026-10-07T03:30:13.369Z",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "cold",
        "witnessAt": "2026-10-10 03:01:47.585+00",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [
          "35093983",
          "35103184",
          "35108257",
          "35121480",
          "35145396"
        ],
        "accepted": false
      },
      "originalReceiptReferences": [
        {
          "requestId": "35093983",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "35103184",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "35108257",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "35121480",
          "receiptState": "unresolved",
          "acceptedUnique": false,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        },
        {
          "requestId": "35145396",
          "receiptState": "queued",
          "acceptedUnique": true,
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json"
        }
      ],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [
        {
          "requestId": "35121480",
          "owner": "EI-25879870290163805",
          "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold32-existing-original24-custody-and-native-frame-review-v2-424d5.json",
          "receiptAccepted": false
        }
      ],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
      "candidateReason": "native-error",
      "frozenClaimCount": 4,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "justified-owner-stop-or-handoff",
        "workRefs": [
          "EI-24922683639239432",
          "EI-24870209437597571",
          "EI-24923992688505913"
        ],
        "stopReason": "Explicit owner-verified handoff to su-7a94555d; P-010 and unfinished tutorial work checkpointed and released. Healthy verification child preserved.",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "cold",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-ffb42793-4137-46e2-8f7e-5b78c92ed607",
      "candidateReason": "silent-since-failed-respawn",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": null,
      "ambiguousWorkedByItemRefs": [
        "EI-25344560942724053"
      ],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "warm",
        "witnessAt": "2026-10-10 06:26:34.535+00",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [
          "35189202",
          "35203471",
          "35212998",
          "35217985"
        ],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-respawn-03e7b214f48eef2846ff673f14bfc298",
      "candidateReason": "native-error",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "WI-10005636"
        ],
        "stopReason": "stalled-loops-guard (WI-6639): turns-stalled: 8 fire(s), last fired 2026-10-06T21:08:32.946Z, last turn 2026-10-06T20:34:21.072Z",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "warm",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-respawn-302388a21ed7ab77379045848faa0690",
      "candidateReason": "silent-since-failed-respawn",
      "frozenClaimCount": 1,
      "frozenParkedOn": [
        "fleet:nonp2p-bug-drain-luna-max-0930:wi-10005351:next-instrumented-adoption",
        "conversation:answered:conv-muw5c4jp-0000-fa494f68a4994f6a8929a04e7bf73a4d"
      ],
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "EI-25231240145060739"
        ],
        "stopReason": "",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "cold",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-respawn-d4be19ee8a5d30542446e0190ae6afe4",
      "candidateReason": "native-error",
      "frozenClaimCount": 1,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "resume-candidate",
        "workRefs": [
          "EI-25255381672029819"
        ],
        "stopReason": "stalled-loops-guard (WI-6639): turns-stalled: 7 fire(s), last fired 2026-10-06T21:08:33.076Z, last turn 2026-10-06T20:36:16.813Z",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "warm",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    },
    {
      "ownerId": "su-respawn-f5b5aaaedcd83439ae8e1d33621374ae",
      "candidateReason": "native-error",
      "frozenClaimCount": 2,
      "frozenParkedOn": null,
      "originalCutoff": "2026-10-10T16:00:36.515Z",
      "priorWaitEvidence": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "decision": "justified-scoped-wait",
        "workRefs": [
          "EI-24784347175311547",
          "EI-24820703359909811"
        ],
        "stopReason": "Blocked: the inbox confirmation was already handled and provides no exact caller/trace link; EI-247 remains open and EI-248 blocked. This is the bounded no-delta stop condition.",
        "limit": "Earlier frozen review; not a certified whole owner window at the final cutoff"
      },
      "ambiguousWorkedByItemRefs": [],
      "workedByLimit": "Claim and release entries have no direction; these are references for original source lookup, not assigned-item custody",
      "existingSixCaseSourceAssessment": null,
      "carryContinuityPreparation": {
        "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json",
        "value": "cold",
        "witnessAt": "2026-10-10T01:09:46.552Z",
        "explicitCarryRequestIds": [],
        "implicitArmIds": [],
        "compactionRequestIds": [],
        "accepted": false
      },
      "originalReceiptReferences": [],
      "missingFullOriginalSources": [],
      "retainedUnacceptedNativeFrames": [],
      "eligibilityVerdict": "unfrozen",
      "outcomesJoined": false,
      "remainingEvidence": [
        "Read original pre-cutoff held-item/owner-stop/budget/dependency witnesses; distinguish reachable independent work from step-specific waits",
        "Reconcile exact cutoff assignment and control continuity before whole-cohort freeze"
      ]
    }
  ],
  "summary": {
    "originalPopulation": 116,
    "membershipPreserved": true,
    "preparedRows": 116,
    "existingSourceSupportedEligible": 4,
    "existingSourceSupportedExcluded": 2,
    "newSourceAssessments": 0,
    "withoutExistingSixCaseAssessment": 110,
    "priorEvidenceDispositions": {
      "resume-candidate": 67,
      "justified-scoped-wait": 12,
      "no-earlier-decision": 26,
      "justified-owner-stop-or-handoff": 3,
      "justified-owner-pause": 3,
      "justified-recorded-dependency": 3,
      "justified-idle-or-handoff": 1,
      "justified-budget-or-time-bound": 1
    },
    "ownersWithFrozenParkedOn": 17,
    "ownersWithNoFrozenClaims": 2,
    "preservedReceiptPopulation": 137,
    "preservedAcceptedReceipts": 113,
    "unresolvedReceipts": 24,
    "newAcquisitions": 0,
    "frozenParserExecutions": 0,
    "continuityAccepted": 0,
    "eligibilityAccepted": 0,
    "outcomesJoined": 0
  },
  "limits": [
    "This is a new preparation index of existing evidence, not a completed assessment or an eligibility freeze.",
    "Do not replace original ownerIds or shrink membership after observing recovery outcomes.",
    "Current claims, worked_by_history and old stop prose do not independently establish cutoff eligibility.",
    "Existing six-case conclusions and original113 receipts remain unchanged; retain24 unresolved.",
    "No original acquisitions or completed source assessments are rerun. No source/product tests, new wakes, route/account changes, restore, terminal close or LIVE_GATE_OPS."
  ]
}
