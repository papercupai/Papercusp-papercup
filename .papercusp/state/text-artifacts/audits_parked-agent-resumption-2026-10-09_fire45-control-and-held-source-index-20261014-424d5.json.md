---
rel_path: "audits/parked-agent-resumption-2026-10-09/fire45-control-and-held-source-index-20261014-424d5.json"
updated_at: 1792015177311
_body: "content"
---

{
  "schemaVersion": "parked-r13-fire45-control-and-held-source-index-v1",
  "observedAt": "2026-10-14T21:59:37.301Z",
  "ownerId": "su-424d5476-0b13-401a-a926-0aaa9f212391",
  "workItem": "WI-6554700010008887",
  "cohortHash": "24ff6981fd54f120f96381dd93732ec9c1bfb2101d7eec063119bf85caeb163a",
  "cutoff": "2026-10-10T16:00:36.515Z",
  "construction": "Derive only from retained artifacts; no fresh cohort query, receipt acquisition, native replay, original-output substitution or outcome join.",
  "sourceRefs": [
    {
      "ref": "audits/parked-agent-resumption-2026-10-09/r13-five-wait-control-residue-20261014-424d5.json",
      "chars": 13569
    },
    {
      "ref": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json",
      "chars": 547104
    },
    {
      "ref": "audits/parked-agent-resumption-2026-10-09/fire44-saved17-locator-dispositions-20261014-424d5.json",
      "chars": 18984
    },
    {
      "ref": "audits/parked-agent-resumption-2026-10-09/r13-cold57-held-item-step-applicability-source-424d5.json",
      "chars": 141784
    }
  ],
  "waitRows": [
    {
      "ownerId": "su-1415d088-0af5-4299-a5df-8dbfc634335b",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/11",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/11",
        "governingSevenCaseSource": null
      },
      "preCutoffWaitCallSources": [
        {
          "id": "35135615",
          "coord_owner_id": "su-1415d088-0af5-4299-a5df-8dbfc634335b",
          "invoked_at": "2026-10-10 04:32:36.306+00",
          "tool_name": "events:await",
          "status": "ok",
          "args_json": {
            "note": "Resume settlement of EI-25558951306471827 after the held papercusp git-sync resource is released.",
            "event": "resource:released:git-sync:papercusp",
            "on_timeout": "wake",
            "timeout_sec": 1200
          }
        },
        {
          "id": "35138902",
          "coord_owner_id": "su-1415d088-0af5-4299-a5df-8dbfc634335b",
          "invoked_at": "2026-10-10 04:40:03.167+00",
          "tool_name": "events:await",
          "status": "ok",
          "args_json": {
            "note": "The prior release wake found the system auto-commit still holding git-sync:papercusp; resume settlement after that sync releases its lock.",
            "event": "resource:released:git-sync:papercusp",
            "on_timeout": "wake",
            "timeout_sec": 1200
          }
        }
      ],
      "retainedPostWitnessControls": {
        "explicitCarryRequests": [],
        "implicitArms": [],
        "compactionRequests": [
          {
            "id": "35246962",
            "at": "2026-10-10 08:46:34.597+00",
            "status": "ok"
          },
          {
            "id": "35257928",
            "at": "2026-10-10 09:09:15.586+00",
            "status": "ok"
          },
          {
            "id": "35268060",
            "at": "2026-10-10 09:35:13.222+00",
            "status": "ok"
          },
          {
            "id": "35284056",
            "at": "2026-10-10 10:11:28.014+00",
            "status": "ok"
          },
          {
            "id": "35305755",
            "at": "2026-10-10 11:04:58.432+00",
            "status": "ok"
          }
        ],
        "continuity": "unverified-receipt-and-native-source-needed"
      },
      "assessment": {
        "historicalWaitCallEvidence": "present",
        "finalCutoffApplicability": "unverified",
        "cutoffContinuity": "unverified",
        "eligibilityAccepted": false,
        "outcomeJoined": false
      }
    },
    {
      "ownerId": "su-312c90f2-a3bd-4c92-ac4e-4eae40ae2647",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/22",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/22",
        "governingSevenCaseSource": null
      },
      "preCutoffWaitCallSources": [
        {
          "id": "35121128",
          "coord_owner_id": "su-312c90f2-a3bd-4c92-ac4e-4eae40ae2647",
          "invoked_at": "2026-10-10 03:59:37.117+00",
          "tool_name": "events:await",
          "status": "ok",
          "args_json": {
            "event": "resource:released:git-sync:papercusp",
            "on_timeout": "wake",
            "timeout_sec": 300
          }
        }
      ],
      "retainedPostWitnessControls": {
        "explicitCarryRequests": [],
        "implicitArms": [],
        "compactionRequests": [
          {
            "id": "34983377",
            "at": "2026-10-09 23:14:36.105+00",
            "status": "ok"
          },
          {
            "id": "35040409",
            "at": "2026-10-10 01:07:20.043+00",
            "status": "ok"
          },
          {
            "id": "35063976",
            "at": "2026-10-10 01:55:54.773+00",
            "status": "ok"
          },
          {
            "id": "35089988",
            "at": "2026-10-10 02:53:27.727+00",
            "status": "ok"
          },
          {
            "id": "35109461",
            "at": "2026-10-10 03:35:15.464+00",
            "status": "ok"
          },
          {
            "id": "35119644",
            "at": "2026-10-10 03:56:25.068+00",
            "status": "ok"
          },
          {
            "id": "35239534",
            "at": "2026-10-10 08:28:44.194+00",
            "status": "ok"
          }
        ],
        "continuity": "unverified-receipt-and-native-source-needed"
      },
      "assessment": {
        "historicalWaitCallEvidence": "present",
        "finalCutoffApplicability": "unverified",
        "cutoffContinuity": "unverified",
        "eligibilityAccepted": false,
        "outcomeJoined": false
      }
    },
    {
      "ownerId": "su-8d2cb6cc-8f27-4a25-8541-b00927471b94",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/60",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/60",
        "governingSevenCaseSource": null
      },
      "preCutoffWaitCallSources": [
        {
          "id": "35105829",
          "coord_owner_id": "su-8d2cb6cc-8f27-4a25-8541-b00927471b94",
          "invoked_at": "2026-10-10 03:25:32.163+00",
          "tool_name": "events:await",
          "status": "ok",
          "args_json": {
            "event": "resource:released:git-sync:papercusp",
            "on_timeout": "wake",
            "timeout_sec": 600
          }
        }
      ],
      "retainedPostWitnessControls": {
        "explicitCarryRequests": [],
        "implicitArms": [],
        "compactionRequests": [
          {
            "id": "35133707",
            "at": "2026-10-10 04:28:04.495+00",
            "status": "ok"
          }
        ],
        "continuity": "unverified-receipt-and-native-source-needed"
      },
      "assessment": {
        "historicalWaitCallEvidence": "present",
        "finalCutoffApplicability": "unverified",
        "cutoffContinuity": "unverified",
        "eligibilityAccepted": false,
        "outcomeJoined": false
      }
    },
    {
      "ownerId": "su-d88420f0-c0b4-4dc7-92c7-f60ab3ddab44",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/95",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/95",
        "governingSevenCaseSource": null
      },
      "preCutoffWaitCallSources": [
        {
          "id": "35185781",
          "coord_owner_id": "su-d88420f0-c0b4-4dc7-92c7-f60ab3ddab44",
          "invoked_at": "2026-10-10 06:23:50.816+00",
          "tool_name": "loop:end",
          "status": "ok",
          "args_json": {
            "reason": "Restore the original fleet lane goal after a formatting-only re-arm difference, then re-arm it at the blocker-appropriate cadence.",
            "harness": "papercusp",
            "acknowledgeOpenDirectives": true,
            "acknowledgeWakeLessAutonomy": true
          }
        }
      ],
      "retainedPostWitnessControls": {
        "explicitCarryRequests": [],
        "implicitArms": [],
        "compactionRequests": [
          {
            "id": "35217653",
            "at": "2026-10-10 07:37:54.22+00",
            "status": "ok"
          },
          {
            "id": "35232736",
            "at": "2026-10-10 08:14:45.849+00",
            "status": "ok"
          },
          {
            "id": "35246481",
            "at": "2026-10-10 08:45:27.344+00",
            "status": "ok"
          },
          {
            "id": "35271105",
            "at": "2026-10-10 09:42:40.729+00",
            "status": "ok"
          },
          {
            "id": "35289337",
            "at": "2026-10-10 10:23:54.672+00",
            "status": "ok"
          }
        ],
        "continuity": "unverified-receipt-and-native-source-needed"
      },
      "assessment": {
        "historicalWaitCallEvidence": "present",
        "finalCutoffApplicability": "unverified",
        "cutoffContinuity": "unverified",
        "eligibilityAccepted": false,
        "outcomeJoined": false
      }
    },
    {
      "ownerId": "su-f6e9cbee-faee-465e-9281-2743f85a91ab",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/106",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/106",
        "governingSevenCaseSource": null
      },
      "preCutoffWaitCallSources": [
        {
          "id": "35066042",
          "coord_owner_id": "su-f6e9cbee-faee-465e-9281-2743f85a91ab",
          "invoked_at": "2026-10-10 02:01:29.151+00",
          "tool_name": "loop:end",
          "status": "ok",
          "args_json": {
            "acknowledgeOpenDirectives": true,
            "acknowledgeWakeLessAutonomy": true
          }
        }
      ],
      "retainedPostWitnessControls": {
        "explicitCarryRequests": [],
        "implicitArms": [],
        "compactionRequests": [
          {
            "id": "35069597",
            "at": "2026-10-10 02:09:52.703+00",
            "status": "refused"
          },
          {
            "id": "35096877",
            "at": "2026-10-10 03:07:21.967+00",
            "status": "ok"
          }
        ],
        "continuity": "unverified-receipt-and-native-source-needed"
      },
      "assessment": {
        "historicalWaitCallEvidence": "present",
        "finalCutoffApplicability": "unverified",
        "cutoffContinuity": "unverified",
        "eligibilityAccepted": false,
        "outcomeJoined": false
      }
    }
  ],
  "governingCases": [
    {
      "ownerId": "su-298f8b56-c687-404f-99e1-d1c1e53baf0c",
      "heldSourcePath": {
        "artifact": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "rowOwnerId": "su-298f8b56-c687-404f-99e1-d1c1e53baf0c",
        "field": "originalWaitEvidence.resumeConditions"
      },
      "controlSource": {
        "ownerId": "su-298f8b56-c687-404f-99e1-d1c1e53baf0c",
        "originalLabel": "justified-owner-stop-or-handoff",
        "sourceReason": "fleet:kill — Owner-directed migration of six-hour Claude census to headless GPT-6.1 Sol; terminate predecessor before identity-preserving recovery.",
        "sourceClassification": "recorded-explicit-stop-or-handoff",
        "originalWorkRefs": [
          "WI-10006954",
          "WI-10007012",
          "WI-10006967"
        ],
        "frozenClaimCount": 4,
        "frozenParkedOn": null,
        "assessment": "review-open",
        "remaining": "Read original source and any later governing control through cutoff; a prior label or system guard alone does not establish an owner pause or a final eligibility exclusion."
      },
      "withdrawalSource": {
        "ownerId": "su-298f8b56-c687-404f-99e1-d1c1e53baf0c",
        "controlApplicability": "review-open",
        "heldItemDisposition": "review-open",
        "cutoffAssignment": "review-open",
        "cutoffExclusionAccepted": false,
        "originalReason": "fleet:kill — Owner-directed migration of six-hour Claude census to headless GPT-6.1 Sol; terminate predecessor before identity-preserving recovery.",
        "measuredControlFinding": "Fleet kill32585240 at2026-10-07T01:56:11.642Z follows self arm32540116 at00:35:16.205Z. Frozen bootstrap first-seen01:56:16.264707Z records same owner migration; neither proves continuing final-cutoff owner pause.",
        "additionalFacts": [],
        "remaining": "Resolve complete held-item applicability and dated assignment/control reachability through final cutoff. Earlier source witnesses do not establish final exclusion or legitimacy of every held item."
      },
      "originalHeldNextActions": [
        {
          "id": "WI-10006954",
          "next": {
            "status": "unknown",
            "reason": "the checkpoint has no \"## Next action\" section; read it directly"
          },
          "blockers": {
            "status": "known",
            "value": [],
            "source": "workItem.payload external blockers (active)"
          }
        },
        {
          "id": "WI-10007012",
          "next": {
            "status": "known",
            "value": "Read amendment review result; apply only with reviewer approvalRef. Preview has R-1 git/post-bind scope, all D-001 sourceRefs, R-4 positive control, R-5 auditedSha+fallback and audit.test.ts, R-6 existing ship gate suite.\n\n---\n02:23Z current-build audit check: ptool --url=http://127.0.0.1:3170 plans:audit dryRun P-002 accepted the committed blob and recorded working-tree drift only as a note. The same :3070 read refused. This confirms the earlier apparent regression is a stale release-runtime false premise. dev:pipeline_position servingRuntimes: release d740fc3802 containsChange=false; staging 36780a883d containsChange=true. Five proof suites passed 257/257; ledger runs 20877058 reader, 20877059 bind-from-test-run, 20877060 bind-spec-evidence, 20877061 audit handler, 20877062 plan-audits.\n\n---\n02:26Z amendment APPLIED: outside approval thread-post:1161167 approves preview 1161140. Rubric revision 3, subject plan revision 36, six BARs; changed clauses AUTO-BAR R1/R2/R4/R5 rev3, R3 rev4, R6 rev1. Completion audit #3 at 22bade1c recorded all six items on staging :3170; release :3070 lacks P-019 so use ptool --url=http://127.0.0.1:3170 for audit. Vetting re-requested in SAME consult conv-muxdjbjw-0000-046f3f801a534d71bf7dae4e32560a71 post1161169 (exchange2/4); responder woken. R6 proof already bound ID28024 from test-run20876617, advisory unvetted-before-proof: pause other proof until vetting and revision-pinned meta attestation. Five proof suite ledger runs20877058-62 all pass/harness papercusp, shared-tree dirty=true; test source paths measured automatically on bind. No claim of whole import closure clean or deployment.\n\n---\n[turn:01a11413@2026-10-07T02:27:20.272Z] Vetting post1161172 found sole detector gap: R6 missing audit-time fingerprint branch untested. Added test to existing plan-code-audit-gate.test.ts with successful fixture positive control then delete blobSha and assert audit_coverage_stale + audit#7 message. testing:run20877145 passed29/29. Re-vet requested same consult (exchange3/4), rubric staysrev3. Next await vetting and meta attestation; remaining binds/cards/grade/ship still open.\n\n---\n[turn:01a11413@2026-10-07T02:27:20.272Z] Six copy-out overlay mutants CAUGHT with byte-identical tracked-source integrity: R1run20877212, R2run20877221, R3run20877214, R4run20877208, R5run20877222, R6run20877213. Bound paired tests+metadata and15 mutations; all15 executable clauses adequacy PASS. Emitted15 exact evaluator scorecard drafts (10 persisted before code-run timeout, ledger read prevented duplicates, remaining5 emitted). Meta attestation EI25286087013547486 atrev3 awaits grading-integrity audit. R6 lifecycle activated via set-specs: nowrev2, proof carriedforward2, evaluatorPASS. Staging audit4 refreshed onlyP002/P019 at5dfc6bff,4 others carried. Ship still PRE-GRADING blocked by card audits and committed-vs-live proof mismatch (R4stale,R3/R5uncertain). git-sync fire on3271 skipped held_exclusive by system:git-sync:1744589; event resource:released:git-sync:papercusp awaited236381(timeout3m). Meta grading-integrity event awaited236405 targetedEI25286087013547486(timeout3m).\n\n---\n[turn:01a11413@2026-10-07T02:46:06.726Z] Audit4 plan-input wake was stale evidence, not a card settlement. Fresh staging ship probe still PRE-GRADING: R1/R2/R4/R6proof_stale;R3/R5proof_uncertain;all6proof_inadequate pendingcardaudits. Release get-spec-evidence measures working-tree current for R1/R4; staging ship measures committed M. git status confirms committed-tree-reader.ts and plan-code-audit-gate.test.ts remain dirty. Do not rerun the six mutation probes merely to reconstruct evidence. First let exact git-sync resource-release236381 unblock commit; caller-owned await still active. Meta-card audit pending; task0muxhrd8g1kmu53826v running, log updated(age1s) with no quotaFailure detected; progress of substantive audit still not yet proved. Targeted meta integrity await236405 active(timeout02:48:14Z). Preserve proof/card IDs from priorcheckpoint. Current next step commit alignment plus independent audits; no code edit needed until fresh evidence names one.",
            "source": "checkpoint carry-note ## Next action"
          },
          "blockers": {
            "status": "known",
            "value": [
              "plan item proof-freshness-pinned-candidate-2026-10-06#P-019 is done (plan-item proof-freshness-pinned-candidate-2026-10-06#P-019 is already done — its work-item is stale residue of completed/abandoned work, not open work)"
            ],
            "source": "work_items:get.planItemBlocked + workItem.payload external blockers (active)"
          }
        },
        {
          "id": "WI-10006967",
          "next": {
            "status": "unknown",
            "reason": "the checkpoint has no \"## Next action\" section; read it directly"
          },
          "blockers": {
            "status": "known",
            "value": [],
            "source": "workItem.payload external blockers (active)"
          }
        }
      ],
      "originalReviewedWorkRefs": [
        "WI-10006954",
        "WI-10007012",
        "WI-10006967"
      ],
      "sourceScope": [
        "census.json",
        "review-data.json",
        "loops-1.json"
      ],
      "stepApplicabilityAssessment": "Migration terminates predecessor; source map names only three held references while frozen count is four. Resolve unnamed held item and original next-action bodies before applicability.",
      "controlApplicability": "review-open",
      "cutoffAssignment": "review-open",
      "eligibilityAccepted": false,
      "sourceSnapshotCardinality": {
        "frozenClaimCount": 4,
        "namedReviewedWorkRefs": 3,
        "sameInstantEqualityEstablished": false
      },
      "independentSourceRow": 18
    },
    {
      "ownerId": "su-3077f62c-1a5d-4be6-896c-e75866032dcb",
      "heldSourcePath": {
        "artifact": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "rowOwnerId": "su-3077f62c-1a5d-4be6-896c-e75866032dcb",
        "field": "originalWaitEvidence.resumeConditions"
      },
      "controlSource": {
        "ownerId": "su-3077f62c-1a5d-4be6-896c-e75866032dcb",
        "originalLabel": "justified-owner-stop-or-handoff",
        "sourceReason": "Owner stopped my tool use and asked me to wait for their go-ahead. Ending the 2-minute loop so its wakes don't restart work behind the owner's back. Re-arm with the same goal (carry gate-throughput-shift-left-2026-10-06 to shipped) once the owner says continue.",
        "sourceClassification": "recorded-explicit-stop-or-handoff",
        "originalWorkRefs": [
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
        "frozenClaimCount": 11,
        "frozenParkedOn": null,
        "assessment": "review-open",
        "remaining": "Read original source and any later governing control through cutoff; a prior label or system guard alone does not establish an owner pause or a final eligibility exclusion."
      },
      "withdrawalSource": {
        "ownerId": "su-3077f62c-1a5d-4be6-896c-e75866032dcb",
        "controlApplicability": "review-open",
        "heldItemDisposition": "review-open",
        "cutoffAssignment": "review-open",
        "cutoffExclusionAccepted": false,
        "originalReason": "Owner stopped my tool use and asked me to wait for their go-ahead. Ending the 2-minute loop so its wakes don't restart work behind the owner's back. Re-arm with the same goal (carry gate-throughput-shift-left-2026-10-06 to shipped) once the owner says continue.",
        "measuredControlFinding": "Exact indexed native b293b5d8 parts61/62 are authenticated continue directives; part72 at2026-10-07T00:04:32.478Z asks whether last command was safe; assistant part74 voluntarily promises to wait. Self loopend32524471 at00:08:02.153Z describes an owner stop, but these literal turns do not by themselves establish an owner-requested indefinite pause. Fleetkill32586357 at01:57:50.425Z is later identity-preserving migration.",
        "additionalFacts": [],
        "remaining": "Resolve complete held-item applicability and dated assignment/control reachability through final cutoff. Earlier source witnesses do not establish final exclusion or legitimacy of every held item."
      },
      "originalHeldNextActions": [
        {
          "id": "WI-10006984",
          "next": {
            "status": "unknown",
            "reason": "the checkpoint has no \"## Next action\" section; read it directly"
          },
          "blockers": {
            "status": "known",
            "value": [],
            "source": "workItem.payload external blockers (active)"
          }
        },
        {
          "id": "WI-10007019",
          "next": {
            "status": "unknown",
            "reason": "the checkpoint has no \"## Next action\" section; read it directly"
          },
          "blockers": {
            "status": "known",
            "value": [],
            "source": "workItem.payload external blockers (active)"
          }
        },
        {
          "id": "WI-10007021",
          "next": {
            "status": "unknown",
            "reason": "the checkpoint has no \"## Next action\" section; read it directly"
          },
          "blockers": {
            "status": "known",
            "value": [],
            "source": "workItem.payload external blockers (active)"
          }
        },
        {
          "id": "WI-10006981",
          "next": {
            "status": "unknown",
            "reason": "the checkpoint has no \"## Next action\" section; read it directly"
          },
          "blockers": {
            "status": "known",
            "value": [],
            "source": "workItem.payload external blockers (active)"
          }
        },
        {
          "id": "WI-10006985",
          "next": {
            "status": "unknown",
            "reason": "the checkpoint has no \"## Next action\" section; read it directly"
          },
          "blockers": {
            "status": "known",
            "value": [],
            "source": "workItem.payload external blockers (active)"
          }
        },
        {
          "id": "WI-10007020",
          "next": {
            "status": "unknown",
            "reason": "the checkpoint has no \"## Next action\" section; read it directly"
          },
          "blockers": {
            "status": "known",
            "value": [],
            "source": "workItem.payload external blockers (active)"
          }
        },
        {
          "id": "WI-10006983",
          "next": {
            "status": "unknown",
            "reason": "the checkpoint has no \"## Next action\" section; read it directly"
          },
          "blockers": {
            "status": "known",
            "value": [],
            "source": "workItem.payload external blockers (active)"
          }
        },
        {
          "id": "WI-10006963",
          "next": {
            "status": "unknown",
            "reason": "the checkpoint has no \"## Next action\" section; read it directly"
          },
          "blockers": {
            "status": "known",
            "value": [],
            "source": "workItem.payload external blockers (active)"
          }
        },
        {
          "id": "WI-10006982",
          "next": {
            "status": "unknown",
            "reason": "the checkpoint has no \"## Next action\" section; read it directly"
          },
          "blockers": {
            "status": "known",
            "value": [],
            "source": "workItem.payload external blockers (active)"
          }
        },
        {
          "id": "WI-10006964",
          "next": {
            "status": "unknown",
            "reason": "the checkpoint has no \"## Next action\" section; read it directly"
          },
          "blockers": {
            "status": "known",
            "value": [],
            "source": "workItem.payload external blockers (active)"
          }
        },
        {
          "id": "WI-10006962",
          "next": {
            "status": "unknown",
            "reason": "the checkpoint has no \"## Next action\" section; read it directly"
          },
          "blockers": {
            "status": "known",
            "value": [],
            "source": "workItem.payload external blockers (active)"
          }
        }
      ],
      "originalReviewedWorkRefs": [
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
      "sourceScope": [
        "census.json",
        "review-data.json",
        "loops-1.json"
      ],
      "stepApplicabilityAssessment": "All eleven original held references have unknown next action in prior review. Literal continue and safety-question controls do not establish indefinite pause; original next-action and cutoff assignments remain required.",
      "controlApplicability": "review-open",
      "cutoffAssignment": "review-open",
      "eligibilityAccepted": false,
      "sourceSnapshotCardinality": {
        "frozenClaimCount": 11,
        "namedReviewedWorkRefs": 11,
        "sameInstantEqualityEstablished": false
      },
      "independentSourceRow": 21
    },
    {
      "ownerId": "su-353a50d8-bcff-423e-9334-9498ed6ff4e9",
      "heldSourcePath": {
        "artifact": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "rowOwnerId": "su-353a50d8-bcff-423e-9334-9498ed6ff4e9",
        "field": "originalWaitEvidence.resumeConditions"
      },
      "controlSource": {
        "ownerId": "su-353a50d8-bcff-423e-9334-9498ed6ff4e9",
        "originalLabel": "justified-owner-pause",
        "sourceReason": "Fleet leadership transferred; obsolete supervision loop must stop. Owned WI-10007305 is blocked on enforced peer source/test locks. Ticket c6fefb66-c094-479b-bdc4-1c096f6732b8 has deliberate registered grant wake await244096 and bounded lapse wake. Checkpoints saved; resume regression/fix as member on grant.",
        "sourceClassification": "leadership-handoff-and-peer-lock",
        "originalWorkRefs": [
          "WI-10007305"
        ],
        "frozenClaimCount": 1,
        "frozenParkedOn": [
          "coord:inbox-wake:su-353a50d8-bcff-423e-9334-9498ed6ff4e9"
        ],
        "assessment": "review-open",
        "remaining": "Read original source and any later governing control through cutoff; a prior label or system guard alone does not establish an owner pause or a final eligibility exclusion."
      },
      "withdrawalSource": {
        "ownerId": "su-353a50d8-bcff-423e-9334-9498ed6ff4e9",
        "controlApplicability": "review-open",
        "heldItemDisposition": "review-open",
        "cutoffAssignment": "review-open",
        "cutoffExclusionAccepted": false,
        "originalReason": "Fleet leadership transferred; obsolete supervision loop must stop. Owned WI-10007305 is blocked on enforced peer source/test locks. Ticket c6fefb66-c094-479b-bdc4-1c096f6732b8 has deliberate registered grant wake await244096 and bounded lapse wake. Checkpoints saved; resume regression/fix as member on grant.",
        "measuredControlFinding": "Last successful self loopend33614080 at2026-10-08T02:22:17.432Z cites original failed-native-phase evidence after independent work; earlier leadership/lock reason is not sufficient final-cutoff exclusion. Need original held-item reachability/assignment and control applicability.",
        "additionalFacts": [
          "Exact Oct8 injected frame and its original message preserve D-002 custody; this is not a literal owner pause and not a final-cutoff assignment proof."
        ],
        "remaining": "Resolve complete held-item applicability and dated assignment/control reachability through final cutoff. Earlier source witnesses do not establish final exclusion or legitimacy of every held item."
      },
      "originalHeldNextActions": [
        {
          "id": "WI-10007305",
          "next": {
            "status": "known",
            "value": "[turn:01a119fb@2026-10-08T11:45:21.412Z] [self-imposed] Save compact loop carry and park via coord:await-inbox. Resume only for a current directed leader admission/reconciliation/custody disposition or genuine distinguishing ORIGINAL native-phase evidence. Preserve blocked custody; do not self-release/leave/end under the custody-free cue while assigned/blocked. No further scheduler replay/newlogicalpull/namedclaim/spec-floorrewrite/newguarditem/exhaustedarchivereask/periodicloop/runtimeaction without new admittedinstruction. Native/guard source work need not be repeated to reconstruct proof.",
            "source": "checkpoint carry-note ## Next action"
          },
          "blockers": {
            "status": "known",
            "value": [
              "runtime blocker codex-native-bootstrap:home35623:failed-child-phase-evidence: Original failed native child was replaced; retained captures contain no startup-phase/log evidence distinguishing native SQLite startup from backend silence. Diagnostic guard is fixed locally; original cause requires historical stdout or a failing native-phase capture. (next: work_items:checkpoint WI-10007305 with original native-phase evidence; then clear blocker and resume discrimination.)"
            ],
            "source": "workItem.payload external blockers (active)"
          }
        }
      ],
      "originalReviewedWorkRefs": [
        "WI-10007305"
      ],
      "sourceScope": [
        "census.json",
        "review-data.json",
        "loops-1.json"
      ],
      "stepApplicabilityAssessment": "Original sole held item has a typed original-native-phase evidence blocker. Leadership/lock narrative is superseded in source by this blocker; verify dated native-evidence reachability through cutoff before exclusion.",
      "controlApplicability": "review-open",
      "cutoffAssignment": "review-open",
      "eligibilityAccepted": false,
      "sourceSnapshotCardinality": {
        "frozenClaimCount": 1,
        "namedReviewedWorkRefs": 1,
        "sameInstantEqualityEstablished": false
      },
      "independentSourceRow": 24
    },
    {
      "ownerId": "su-684c584a-3351-49ee-a145-f657d7e42237",
      "heldSourcePath": {
        "artifact": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "rowOwnerId": "su-684c584a-3351-49ee-a145-f657d7e42237",
        "field": "originalWaitEvidence.resumeConditions"
      },
      "controlSource": {
        "ownerId": "su-684c584a-3351-49ee-a145-f657d7e42237",
        "originalLabel": "justified-owner-pause",
        "sourceReason": "stalled-loops-guard (WI-6639): turns-stalled: 26 fire(s), last fired 2026-10-08T16:07:43.142Z, last turn 2026-10-08T15:17:34.670Z",
        "sourceClassification": "system-stalled-loop-guard",
        "originalWorkRefs": [
          "EI-25327682039407935",
          "EI-25380637492003672",
          "WI-10007106"
        ],
        "frozenClaimCount": 3,
        "frozenParkedOn": [
          "work-item:unblocked:WI-10007106",
          "work-item:done:WI-10007305",
          "work-item:claimable",
          "coord:inbox-wake:su-684c584a-3351-49ee-a145-f657d7e42237"
        ],
        "assessment": "review-open",
        "remaining": "Read original source and any later governing control through cutoff; a prior label or system guard alone does not establish an owner pause or a final eligibility exclusion."
      },
      "withdrawalSource": {
        "ownerId": "su-684c584a-3351-49ee-a145-f657d7e42237",
        "controlApplicability": "review-open",
        "heldItemDisposition": "review-open",
        "cutoffAssignment": "review-open",
        "cutoffExclusionAccepted": false,
        "originalReason": "stalled-loops-guard (WI-6639): turns-stalled: 26 fire(s), last fired 2026-10-08T16:07:43.142Z, last turn 2026-10-08T15:17:34.670Z",
        "measuredControlFinding": "Original transition disarmed at2026-10-08T16:14:34.602397Z by auto-pause-loop-routine, stalled-loop guard. Self arm33989039 at13:58:46.372Z precedes it; withdraw rearm-after-guard claim. System guard is not an owner pause.",
        "additionalFacts": [],
        "remaining": "Resolve complete held-item applicability and dated assignment/control reachability through final cutoff. Earlier source witnesses do not establish final exclusion or legitimacy of every held item."
      },
      "originalHeldNextActions": [
        {
          "id": "EI-25327682039407935",
          "next": {
            "status": "known",
            "value": "Grade3 revision requested: narrow a worthwhile change to actual emitted constraint visibility gap, preserve existing P-NNN validation, and require tests covering canonical+alias and bulk declarations.\n\n---\n⟦auto-checkpoint mechanical @2026-10-08T14:55:28.255Z⟧ system turn-end snapshot — the holder's agent-written checkpoint was missing/stale (P-015). Holder-session-level, not item-verified.\nsession: 01a11bd2-d455-7aa3-8c89-ee87b34c94d1\nlatest journal: Added distinct BEGIN and SQL-setup timeout labels. All 400 tests pass.\ntool-log tail:\nBash ×3 (sed -n '1,240p' /home/marsh-office/.papercusp/l…, python3 - <<'PY' from pathlib import Path p=Pat…, sed -n '1,84p' /home/marsh-office/.papercusp/la…) ·\ntools_find ×2 ✓\ncoord_inbox ✓\nimprovements_capture ✓\nwork_items_get ✓\nBash ×32 (sed -n '1950,2070p' libs/papercusp/libs/db/src/…, ptool work_items:get --json - <<'JSON' {\"id\":\"E…, rg -n 'args:|resume|projection|checkpoint|paylo…, +21) ·\napply_patch *** Begin Patch *** Update File: /home/marsh-of… ·\nBash ×4 (ptool locks:release --json - <<'JSON' {\"lock_id…, ptool code:run --json - <<'JSON' {\"script\":\"con…, npm run test:file -- packages/operator-core/lib…, +1) ·\napply_patch *** Begin Patch *** Update File: /home/marsh-of… ·\nBash ×3 (PAPERCUSP_TEST_RUN_HARNESS=papercusp npm run te…, sed -n '166,211p' scripts/lib/committed-source-…, ptool locks:acquire --json - <<'JSON' {\"paths\":…) ·\napply_patch *** Begin Patch *** Update File: /home/marsh-of… ·\nBash ×24 (ptool locks:release --json - <<'JSON' {\"lock_id…, git diff --check -- packages/operator-core/lib/…, ptool work_items:checkpoint --json - <<'JSON' {…, +13) ·",
            "source": "checkpoint carry-note ## Next action"
          },
          "blockers": {
            "status": "known",
            "value": [],
            "source": "workItem.payload external blockers (active)"
          }
        },
        {
          "id": "EI-25380637492003672",
          "next": {
            "status": "known",
            "value": "Honor exactrelease248734 or timeout14:59:11Z, then reconcile source/HEAD and writerprogress before one sanctionedretry. Preserve sourceproof1165129/currentnative35623/12checks. Do not infer physical pool occupancy or historical root from deadline label.",
            "source": "checkpoint carry-note ## Next action"
          },
          "blockers": {
            "status": "known",
            "value": [],
            "source": "workItem.payload external blockers (active)"
          }
        },
        {
          "id": "WI-10007106",
          "next": {
            "status": "known",
            "value": "Remain BLOCKED until genuinely new canonical unblock or directed leader barrier disposition. No activation, propagation, source-owner monitoring, or same-status polling; continue separate admitted EI authority/send diagnosis.\n\n---\nBoundary continuity delta: unchanged attestation againsta0c6db574c4d was refused attestation_state_changed, so no unchanged assertion was accepted. Subsequent direct compact resume positively returned self/BLOCKED, same savedbodyhash and protected nextAction: remainblocked until genuinely new canonicalunblock or directed leaderbarrier disposition; noactivation/propagation/source-owner monitoring/same-status polling. CLI fullread timedout55s and latercompactproxyread returned502/outcomeunknown; neither supplies new history or absenceproof. No runtime actiontaken. Separate admitted EI253806 currentcheckpoint preserves these refs and diagnostic progression; all prior WI evidence retained. No active nativehandle.\n\n---\n⟦auto-checkpoint mechanical @2026-10-08T14:55:28.255Z⟧ system turn-end snapshot — the holder's agent-written checkpoint was missing/stale (P-015). Holder-session-level, not item-verified.\nsession: 01a11bd2-d455-7aa3-8c89-ee87b34c94d1\nlatest journal: Added distinct BEGIN and SQL-setup timeout labels. All 400 tests pass.\ntool-log tail:\nBash ×3 (sed -n '1,240p' /home/marsh-office/.papercusp/l…, python3 - <<'PY' from pathlib import Path p=Pat…, sed -n '1,84p' /home/marsh-office/.papercusp/la…) ·\ntools_find ×2 ✓\ncoord_inbox ✓\nimprovements_capture ✓\nwork_items_get ✓\nBash ×32 (sed -n '1950,2070p' libs/papercusp/libs/db/src/…, ptool work_items:get --json - <<'JSON' {\"id\":\"E…, rg -n 'args:|resume|projection|checkpoint|paylo…, +21) ·\napply_patch *** Begin Patch *** Update File: /home/marsh-of… ·\nBash ×4 (ptool locks:release --json - <<'JSON' {\"lock_id…, ptool code:run --json - <<'JSON' {\"script\":\"con…, npm run test:file -- packages/operator-core/lib…, +1) ·\napply_patch *** Begin Patch *** Update File: /home/marsh-of… ·\nBash ×3 (PAPERCUSP_TEST_RUN_HARNESS=papercusp npm run te…, sed -n '166,211p' scripts/lib/committed-source-…, ptool locks:acquire --json - <<'JSON' {\"paths\":…) ·\napply_patch *** Begin Patch *** Update File: /home/marsh-of… ·\nBash ×24 (ptool locks:release --json - <<'JSON' {\"lock_id…, git diff --check -- packages/operator-core/lib/…, ptool work_items:checkpoint --json - <<'JSON' {…, +13) ·",
            "source": "checkpoint carry-note ## Next action"
          },
          "blockers": {
            "status": "known",
            "value": [
              "runtime blocker resource:git-sync: Protected atomic git-sync barrier prevents coordinated bg-host reload. Root investigation EI-25303530017814636 is addressed through d17e per leader disposition2a84042d; leader d759 retains measured-readiness follow-up. Activation remains blocked under D-002. (next: dev:restart)"
            ],
            "source": "workItem.payload external blockers (active)"
          }
        }
      ],
      "originalReviewedWorkRefs": [
        "EI-25327682039407935",
        "EI-25380637492003672",
        "WI-10007106"
      ],
      "sourceScope": [
        "census.json",
        "review-data.json",
        "loops-3.json"
      ],
      "stepApplicabilityAssessment": "WI-10007106 has typed activation barrier. EI-25327682039407935 has a specific grading revision step and no recorded active external blocker; EI-25380637492003672 has an exact release/timeout condition. Whole-owner exclusion cannot be inferred from WI wait or stalled-loop guard.",
      "controlApplicability": "review-open",
      "cutoffAssignment": "review-open",
      "eligibilityAccepted": false,
      "sourceSnapshotCardinality": {
        "frozenClaimCount": 3,
        "namedReviewedWorkRefs": 3,
        "sameInstantEqualityEstablished": false
      },
      "independentSourceRow": 41
    },
    {
      "ownerId": "su-d759f7bc-0b18-43bd-8945-b839fa0e54c9",
      "heldSourcePath": {
        "artifact": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "rowOwnerId": "su-d759f7bc-0b18-43bd-8945-b839fa0e54c9",
        "field": "originalWaitEvidence.resumeConditions"
      },
      "controlSource": {
        "ownerId": "su-d759f7bc-0b18-43bd-8945-b839fa0e54c9",
        "originalLabel": "justified-owner-pause",
        "sourceReason": "stalled-loops-guard (WI-6639): turns-stalled: 19 fire(s), last fired 2026-10-08T18:13:32.603Z, last turn 2026-10-08T15:18:23.849Z",
        "sourceClassification": "system-stalled-loop-guard",
        "originalWorkRefs": [
          "WI-10007468"
        ],
        "frozenClaimCount": 1,
        "frozenParkedOn": null,
        "assessment": "review-open",
        "remaining": "Read original source and any later governing control through cutoff; a prior label or system guard alone does not establish an owner pause or a final eligibility exclusion."
      },
      "withdrawalSource": {
        "ownerId": "su-d759f7bc-0b18-43bd-8945-b839fa0e54c9",
        "controlApplicability": "review-open",
        "heldItemDisposition": "review-open",
        "cutoffAssignment": "review-open",
        "cutoffExclusionAccepted": false,
        "originalReason": "stalled-loops-guard (WI-6639): turns-stalled: 19 fire(s), last fired 2026-10-08T18:13:32.603Z, last turn 2026-10-08T15:18:23.849Z",
        "measuredControlFinding": "Self loopend33946244 at2026-10-08T12:41:42.262Z cites incident-custody block; later system stalled-loop disarm at18:15:34.673087Z is separate positive control. Need held-work custody/reachability at cutoff; system guard alone is no owner pause.",
        "additionalFacts": [],
        "remaining": "Resolve complete held-item applicability and dated assignment/control reachability through final cutoff. Earlier source witnesses do not establish final exclusion or legitimacy of every held item."
      },
      "originalHeldNextActions": [
        {
          "id": "WI-10007468",
          "next": {
            "status": "known",
            "value": "Resume exact b097 route only on a supported same-owner managed-host custody receipt; do not replay compaction, old monitor, original incident probes or unchanged tests. Stop host-disposition lane per exactstewardd7fff620, preserve current event wakes and handle new applicable fleet transitions once. Canonical deferred EI-25418020058852136 stillopen/unassigned; retained source evidence only.",
            "source": "checkpoint carry-note ## Next action"
          },
          "blockers": {
            "status": "known",
            "value": [
              "gate blocker coord-send-b2acaba0fe3667d918b99a456eb9fc17dfa87b6621d376a3174715fb30d4162e: Safe seat removal requires the registered goal steward's pending consumer/accountability handoff or scope disposition; every measured active or blocked claim remains retained. (next: coord:inbox: recover the actual reply to70435277/b2acaba0, record the named disposition, then verify custody before any graceful exit.)",
              "gate blocker coord-send-f0826164a2d3078f3a04a35c8a954c0959375641b53fd2ded2297aba7e47d4ab: Steward accepted the D-003 withdrawal and retain/noexit constraint. Safe incident custody transfer is unproved; no reply wait or new monitoring lane is open. (next: coord:read only on actual new binding custody disposition or supported custody receipt; no poll/monitor rearm)"
            ],
            "source": "workItem.payload external blockers (active)"
          }
        }
      ],
      "originalReviewedWorkRefs": [
        "WI-10007468"
      ],
      "sourceScope": [
        "census.json",
        "review-data.json",
        "loops-7.json"
      ],
      "stepApplicabilityAssessment": "Original sole held item has two typed custody gates and an explicit no-monitor/no-replay instruction. Automatic loop guard does not supersede this item-specific custody control; original directive and cutoff continuity remain required.",
      "controlApplicability": "review-open",
      "cutoffAssignment": "review-open",
      "eligibilityAccepted": false,
      "sourceSnapshotCardinality": {
        "frozenClaimCount": 1,
        "namedReviewedWorkRefs": 1,
        "sameInstantEqualityEstablished": false
      },
      "independentSourceRow": 89
    },
    {
      "ownerId": "su-ec24b79e-fb5f-4056-847e-c1bd3edfec3a",
      "heldSourcePath": {
        "artifact": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "rowOwnerId": "su-ec24b79e-fb5f-4056-847e-c1bd3edfec3a",
        "field": "originalWaitEvidence.resumeConditions"
      },
      "controlSource": {
        "ownerId": "su-ec24b79e-fb5f-4056-847e-c1bd3edfec3a",
        "originalLabel": "justified-budget-or-time-bound",
        "sourceReason": "dead-man guard: max-duration 1218s > 600s (since arm)",
        "sourceClassification": "system-duration-limit",
        "originalWorkRefs": [
          "EI-25477838487191856"
        ],
        "frozenClaimCount": 1,
        "frozenParkedOn": null,
        "assessment": "review-open",
        "remaining": "Read original source and any later governing control through cutoff; a prior label or system guard alone does not establish an owner pause or a final eligibility exclusion."
      },
      "withdrawalSource": {
        "ownerId": "su-ec24b79e-fb5f-4056-847e-c1bd3edfec3a",
        "controlApplicability": "review-open",
        "heldItemDisposition": "review-open",
        "cutoffAssignment": "review-open",
        "cutoffExclusionAccepted": false,
        "originalReason": "dead-man guard: max-duration 1218s > 600s (since arm)",
        "measuredControlFinding": "Self bounded monitor34520480 at2026-10-09T08:19:47.969Z follows successful lock-wait loopend34483948. Positive duration-guard transition at08:40:05.146013Z is automatic bounded-budget exhaustion, not a literal owner stop. Original held item/control evidence remains required.",
        "additionalFacts": [],
        "remaining": "Resolve complete held-item applicability and dated assignment/control reachability through final cutoff. Earlier source witnesses do not establish final exclusion or legitimacy of every held item."
      },
      "originalHeldNextActions": [
        {
          "id": "EI-25477838487191856",
          "next": {
            "status": "known",
            "value": "[self-imposed] On one bounded monitor wake, recheck df, git-sync:papercusp resource lock, routine status, and path-specific pipeline position. If headroom remains below reserve without a measured safe remediation, end the monitor and park this item with the blocker for fleet re-placement. If headroom clears, run git-sync only after confirming the lock is unheld, then use the operator-api route to verify on :3170 after pipeline position confirms the loaded staging build contains this change.",
            "source": "checkpoint carry-note ## Next action"
          },
          "blockers": {
            "status": "known",
            "value": [],
            "source": "workItem.payload external blockers (active)"
          }
        }
      ],
      "originalReviewedWorkRefs": [
        "EI-25477838487191856"
      ],
      "sourceScope": [
        "census.json",
        "review-data.json",
        "loops-8.json"
      ],
      "stepApplicabilityAssessment": "Original step is a self-imposed bounded resource/pipeline monitor with no recorded active external blocker. Budget exhaustion is source-supported; concrete resource and authority condition at cutoff remains unadjudicated.",
      "controlApplicability": "review-open",
      "cutoffAssignment": "review-open",
      "eligibilityAccepted": false,
      "sourceSnapshotCardinality": {
        "frozenClaimCount": 1,
        "namedReviewedWorkRefs": 1,
        "sameInstantEqualityEstablished": false
      },
      "independentSourceRow": 96
    },
    {
      "ownerId": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
      "heldSourcePath": {
        "artifact": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json",
        "rowOwnerId": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "field": "originalWaitEvidence.resumeConditions"
      },
      "controlSource": {
        "ownerId": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "originalLabel": "justified-owner-stop-or-handoff",
        "sourceReason": "Explicit owner-verified handoff to su-7a94555d; P-010 and unfinished tutorial work checkpointed and released. Healthy verification child preserved.",
        "sourceClassification": "recorded-explicit-stop-or-handoff",
        "originalWorkRefs": [
          "EI-24922683639239432",
          "EI-24870209437597571",
          "EI-24923992688505913"
        ],
        "frozenClaimCount": 4,
        "frozenParkedOn": null,
        "assessment": "review-open",
        "remaining": "Read original source and any later governing control through cutoff; a prior label or system guard alone does not establish an owner pause or a final eligibility exclusion."
      },
      "withdrawalSource": {
        "ownerId": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
        "controlApplicability": "review-open",
        "heldItemDisposition": "review-open",
        "cutoffAssignment": "review-open",
        "cutoffExclusionAccepted": false,
        "originalReason": "Explicit owner-verified handoff to su-7a94555d; P-010 and unfinished tutorial work checkpointed and released. Healthy verification child preserved.",
        "measuredControlFinding": "Self loopend31720878 at2026-10-05T17:42:21.933Z reports tutorial handoff to7a94555d. Frozen4 claims include three EI refs; must prove handoff applicability and whether independent held work remained. Handoff narrative alone cannot exclude whole owner at final cutoff.",
        "additionalFacts": [
          "Exact Oct1 message lifts previous pause; exact Oct5 takeover message and D-021 apply to tutorial P-010/P-012, not automatically to the three independently held EI rows."
        ],
        "remaining": "Resolve complete held-item applicability and dated assignment/control reachability through final cutoff. Earlier source witnesses do not establish final exclusion or legitimacy of every held item."
      },
      "originalHeldNextActions": [
        {
          "id": "EI-24922683639239432",
          "next": {
            "status": "known",
            "value": "Continue bounded instrumented diagnosis/disposition for5773; no blind repeated narrow baselines or fullaffected until responsible root disposition and requiredpostV14a-eaudit/exactcommittedpreflight. Need consider concrete discriminating controlledrealnative experiment or explicit ownedunknown-root disposition, not invent explanation. Read owneranswer and sameheadedpilot launch references if available; do not self-answer. SELF/AUTO/cold60, noLIVE_GATE_OPS/delegation/source-cloneedits.\n\n---\nNative01a0ffb3 preserves clean lifecycle20610306 and stage diagnostics20611473/474. AccountableUNKNOWNnative-latency disposition1156663 with5773stillownedOPEN, not resolved by standalone PASS. PostV14a-eaudit1156664 complete; freshclean4suite99PASS1existingSkip20616329..32 at1f903c8a96, opens23.16/32.94ms. One unchanged fullcontext affectedV15 task0murtdzbq1kaqc701yp RUNNING03:11Z, unique/tmp/cloud-tutorial-explicit-affected-current-v15.log/fullchild3577870-0e7610fd/deadline03:55:28Z. Await actual stage+elapsed trace on recurrence; no load blame/timeout bump/cloneSOURCEedit.\n\n---\n2026-10-03T03:31Z native01a0ffc2/currentoriginalsu: SAME V15 task0murtdzbq1kaqc701yp remainsRUNNING03:30Z/processidentity+cgroup; log31464B/mtime03:30:07, deadline03:55:28.158Z. Completed statefulleg exit1/586s complete2files: tracked-files-helper.test.ts falsepositive restricted-tree prose, watch.test.ts missing findMatchingActiveStandingWatch in committedmock; total3assertionsfailed,1538filespass11skipped/31003testsPASS45skip3todo. Actual A003 full5cases4PASS1existingSkip137ms in SAME V15; NOhistoricalstartuprootresolutioninference. NativeUNKNOWNWI5773/EI249226 and clean20610306/20611473/474 intact. Watch root ALREADY DONE WI10005697 atcurrent190aaa/2c21 receipts; pin1f903 oldmock, currentdiff includes realfakeStore/finder/tests and prior33PASS20615063; do notredo. NewfalsepositiveROOT WI10005805 createdselfWIP, fixed canonicaltracked-files-helper detector by reusing existing mask/liveanchorhelpers, strengthened read/filter/livecall controls; final full29PASS0skip20622400/localdirtytrue at3ae030, sourceblobe9af65d77fc926c6a662c156b81678ddd4876419. 5805 CLOSEDdone finishcomplete:true/authorityproposed, exactlast3linechange awaitingauto git-syncsettlement; doNOTreclose/retest solelytoquerysettlement. Existing WI5778 ownedlive4f968 has guardfailure1156693; peerreported treefix canonicalholder/guard0/118PASS via injectedmessage, not independently cleanproof. No LIVE_GATE_OPS/delegation/timeoutchanges/quarantine/cloneSOURCEedits. coord:orient deliberatelyread currentcodexLocks only: AUTOMATICverified generation1790994641000; no manualper-editlocks. Nativeedits complete, automaticapplyreturned{}, fullsuiteactuallypassed. Acceptancecurrentplan77/rubric9 reviewed: R13 requires exactpromotedartifact/login/P012; R14 stale@4 workcontract vs current@5 and proof requires genuineAvi authorshipresponse. CurrentconvOPEN/null/posts[]03:24Z; pending, no selfanswer/reask/grader. No new affectedlaunch. Preserve separate2/8/7checkrows,12loopchecks. NextattachsameV15 then fullterminalcensus,exactcleanproof+mandatoryaudit before nextexpensiveretry.\n\n---\n[turn:01a0ffe3@2026-10-03T03:52:08.217Z] Current continuation verified this item remains open/assigned to su-fc5749a7. Supersedes older running-V15 follow-up: V15 is terminal RED; sole required current V16 task_id 0murumlm21npqwyq1qv is running, exact tested pin5a907e1ffe, deadline2026-10-03T04:30:09.908Z, unique /tmp/cloud-tutorial-explicit-affected-current-v16.log. Original historical native-startup origin remains UNKNOWN and owned with WI-10005773; no timeout changes or root-resolution claim. Current trace evidence is in WI5773 checkpoint e2c06db258ee and parent/main checkpoints38a7879c4180/a0ecaaf54fb6; attach same task, never restart. Existing diagnostic tests and scoped proof stay retained.\n\n---\n2026-10-03T05:52Z recovery delta supersedes carried RUNNING preflight. Original su-fc5749a7 verified; SELF/AUTO control29/hashb00c482a, same P010 held, automatic verified locks. Existing task0murypuyb6e28xufvso terminalCOMPLETED/exit0, no relaunch: pinb87b1bc2059c2bc5b40681610ac892b575d16270 full6 suites260PASS0skip, requested/executed/matched6/6, pre/post named0dirty/unknown/STAMPED. Actual exact-root LOCAL receipts20638267..20638272 allPASS/worktreeDirty=false at same pin (root/tmp/papercusp-lint-as-committed-b87b1bc205-NjitxE). Both committed guards PASS/rootfqFhg1; complete dry/full/guards logs /tmp/cloud-tutorial-v17-preflight-b87b1bc2059c-{dry,full,guards}.log. Post1156846 stores counts75/17/51/9/36/72 and scope. Dry executed0 is routing only.\nFailed PRE-EXECUTION V17 setup wrapper task0murz3f1j120ztai1c0/bash1f459ccc-e6b ended exit1 at05:50:13Z BEFORE npm or any test and BEFORE creating v17.log. Caller shlex parsed every raw V16 log line and hit an unmatched quote; actual tool/runner terminal receipt .papercusp/scratch/bash-1f459ccc-e6b.log confirms no test launch. Friction captured via improvements:capture observation. Corrected extraction VERIFIED read-only: first select the sole line starting '> node scripts/lint-as-committed.mjs test:affected ' from preserved /tmp/cloud-tutorial-explicit-affected-current-v16.log, THEN shlex.split only that command line, require exactly1 --changed-paths= token/20unique operands. Do NOT shlex arbitrary log output. No actual V17 affected test has executed; do not treat failed setup as testRED or rerun preflight.\nNext AFTER native compaction (current64% exceeds prior60% new-unit ceiling): verify originalidentity, preserve every3/9/8 separate itemcheck and12loopchecks, then at most ONE actual broadV17 at SAME b87b1bc205 pin/original20selector under post-V16 audit1156760. Reuse maintained npm run lint:as-committed -- test:affected --any --ref=<pin> --keep -- --related <exactselector>, unique /tmp/cloud-tutorial-explicit-affected-current-v17.log; refuse overwriting any existing log. Keep2700000ms wrapper deadline budget unchanged. Before launch validate canonical staging,20operands plus11preflight source/test blobs match git show pin:path, prior fullTEST_FILE_RESULT6/6passed and bothguardPASS; no cloneSOURCEedit, timeout/baseline change, delegation or LIVE_GATE_OPS. Do not reattach oldsetup as running or doublelaunch. WholeWI5802DONE dependency withdrawn1156825; its tutorialsidefixcomplete, separatemainOPEN not ourblocker. Genuine Avi conversation conv-murpuwd0-0000-088c795283714b3793806199794bed03/wait222019 remains pending; no reask/selfanswer. Historical V16RED and original A003 startupUNKNOWN WI5773/EI249226 remain; currentPASS cannot establish historical root fix, affectedPASS or shipment. P010/P012/ship remainOPEN.\n\n---\nV17 actual launch (not the previous setup wrapper), 2026-10-03T06:00Z: original su-fc5749a7 verified and P010 alreadyHeld; SELF/AUTO control29 with verified automatic locks. Recovered exact prior launch arguments from native predecessor transcript; saved command-line-only extraction yields1 command,1 selector,20unique operands. Read-only canonical precheck and launch both verified staging root,20selector files plus11 preflight sources/tests byte-identical to immutable b87b1bc2059c2bc5b40681610ac892b575d16270, six-suite full requested/executed/matched6/6 PASS and both committed guards PASS. V17 unique log did not exist and opened exclusively. Actual capability:bash task_id0murzgxsa4oy0qui3lq/bash61cffc54-dc5 launched once with2700000ms deadline2026-10-03T06:45:43.823Z; work-item WI10005128. Initial output V17_PINNED_PRECONDITIONS_PASS, unique /tmp/cloud-tutorial-explicit-affected-current-v17.log contains maintained npm test:affected start and pc-heavy slot acquired. Current same-task liveness process_identity_and_cgroup confirms RUNNING; full child /tmp/pcv/papercusp-affected-tests/4159958-c466cd68.log. No verdict yet. ONLY reattach this task_id, never relaunch. Original failedsetup0murz3 and terminalpreflight0murypuy are not running. Post-V16audit1156760 and corrected dependency1156825 govern. Preserve all original3/9/8 item checks and12loop checks, preflight260PASS scope, historicalV16RED/startupUNKNOWN WI5773/EI249226/browser248097, and genuine Avi conv-murpuwd0/wait222019. No LIVE_GATE_OPS, delegation, timeout/baseline changes or clone source edits. Next: wait on this owned active process at bounded cadence, capture terminal JOB END/exit and complete task/file census with actual clean exact-root LOCAL ledgers before any conclusion. No extra full or focused reruns to reconstruct already saved proof.\n\n---\nContinuation recovery verified original su-fc5749a7 via coord:whoami and P010 alreadyHeld. Actual V17 task0murzgxsa4oy0qui3lq/bash61cffc54-dc5 is RUNNING by fresh process_identity_and_cgroup (pid52688/scopepc-0murzgxsa4oy0qui3lq.service); never relaunch. Unique /tmp/cloud-tutorial-explicit-affected-current-v17.log shows stateful elapsed480s/captured1459100B/stalled0, agent-mcp finished81s exit0, web test started; no terminal verdict. Full child /tmp/pcv/papercusp-affected-tests/4159958-c466cd68.log, exact materialization /tmp/papercusp-lint-as-committed-b87b1bc205-RTfIGr, immutableb87b1bc2059c2bc5b40681610ac892b575d16270, original20selector and deadline2026-10-03T06:45:43.823Z unchanged. Read actual affected writer terminal-result/failing-file semantics in pinned tree before any future count/verdict. Saved whole source checkpoint available at /home/marsh-office/.papercusp/scratch/papercusp-workspace/work_items:get/6076b60a-d8da-4df4-80ed-acd8bfa47b3a/result-door-1791007831970.md; main full10check rows and5773/main/parent counts4/10/9 recovered. AUTO/SELF bounded120s cold workloop active, max2700s/24fires; original Avi conversation await persists. Own open directives0. No repo edits, new tests, LIVE_GATE_OPS, delegation, timeout/baseline changes or clone source edits. Next only reattach V17 at bounded wake; on terminal get JOB END/exit and full task/failing-file census plus exact-root CLEAN LOCAL ledger rows, then disposition permitted work. Preserve audit1156760/correction1156825, preflight260PASS scope, historicalV16RED, historicalstartupUNKNOWN5773/EI249226 and browser248097UNKNOWN. P010/P012/ship OPEN; genuine Avi conv-murpuwd0-0000-088c795283714b3793806199794bed03/wait222019 remains pending. End loop once only genuine Avi human acceptance remains.\n\n---\n[turn:01a1005c@2026-10-03T06:13:31.215Z] V17 PARTIAL stateful result, not overall verdict: originalidentityverified; same task0murzgxsa4oy0qui3lq RUNNING by fresh process_identity_and_cgroup, no relaunch. Unique/tmp/cloud-tutorial-explicit-affected-current-v17.log stateful finished775s exit1; pure300s/349604B/stalled1, operator-vite240s/18183B/stalled0, other tasks continue. Fullstatefuloutput in child4159958-c466cd68 has exactly3failedfiles: claude/omp seed-wire-budget assertions100372B>unchanged100000B and git-sync/run-git-sync-progress queued-output-before-idle assertion. ExactcleanLOCAL rows20643586/20643549/20644423 allworktreeDirtyfalse/b87b1bc2059c2bc5b40681610ac892b575d16270/root/tmp/papercusp-lint-as-committed-b87b1bc205-RTfIGr. This is PARTIAL task evidence; fulltask/failingfilecensus stillpending. Newboundedsourcefollowups WI-10005883(seed pair, relatesdone5434/olderopen4913) and WI-10005884(Git progress) CREATED+ASSIGNED ORIGINALSELF; rootsUNKNOWN until distinguishing measurement, nofixclaim. No newtests/sourceedit/delegation/LIVE_GATE_OPS/timeout/baselineorcloneSOURCEchanges. Otherpreviouswork remainsopen including5814guards untilterminalresidueaccounted. AUTO/SELFcontrol30 unchanged. Read stale wake recovery and predecessor3turntail; currentlive evidence supersedescarryd4d3c4d749dc; lastloopnote81c38ea1e25f wasnewer. Read fulldirectednovicefollowupmessage coord-send-6e03f96178e8082cdf6806e619e8a457c3893a7ee6c1c782eda0d4eade4ad761 and ACKreceiptmus02379; siblingWI10005831 is peer-owned distinctscope, do not supervise. Current67-79% exceedsinherited60%nextunitceiling; flushandcompaction atthisboundary, preserveactivejob. Next verifyoriginalwhoami, reattachONLYactualV17; waitboundeduntilterminaldeadline2026-10-03T06:45:43.823Z, thencompleteJOBEND/exit/task+filecensus/exactcleanLOCALledgerlookup beforeoverallconclusion. Preserveall4/10/9 itemchecks/12loopchecks, audits1156760/correction1156825, preflight260PASSscope/historicalV16RED/startupUNKNOWN5773/EI249226/browser248097, genuineAvi conv-murpuwd0-0000-088c795283714b3793806199794bed03/wait222019. P010/P012/SHIPOPEN. Onceonlygenuinehumanwaitremains endworkloop.\n\n---\n[turn:01a1005c@2026-10-03T06:24:21.713Z] Delayed loopwake carried81c38ea1e25f, superseded by current99e3785a4075 and parentpost1156886. Original su-fc5749a7 verifiedagain; ONLY actualV17task0murzgxsa4oy0qui3lq remainsRUNNING. Current uniquev17log pure540s/766384B/stalled5; operator-vitefinished428sexit0. Historical completedstateful3failedfiles andowned5883/5884 remain; fulloverallcensusPENDING. No relaunch/sourceedit/testretry/LIVE_GATE_OPS/delegation/timeoutbaselinechange. Samepinb87b1bc205/rootRTfIGr/original20selector/deadline06:45:43.823Z. Allsaved4/10/9itemchecksand12loopchecks preserve; genuineAviwaitandstartupUNKNOWNremain. Compaction re-request atcleanboundary; successoronlyreattachandcollectterminalfullcensusbeforeconclusion.\n\n---\n2026-10-03 native01a100c3 continuation originalsu/currentholder verified. No new measured startupstage/native delay or root attribution. No source edit/test/job. Prior fullaffected terminalRED, current lifecycle/telemetry guards stay scopedPASS; historicalstartupUNKNOWN. ManualR14 contractreview is remainingindependentwork on4837. Fresh a-eaudit and committedpreflight before exactlyone nextaffected run. Preserve prior nativeevidence and checks. Contextsettle; loop788ec57f8a0a.\n\n---\n2026-10-03 originalidentity/currentclaim reread; no additionalnative-openstage/rootmeasurement. HistoricalstartupUNKNOWN while lifecycle/diagnosticdetectors remain independentlyverified. Currenttutorialsourcepin repair4837 current46c034d7c2 scoped17-suite session36487 running (not affected); log /tmp/cloud-tutorial-p010-current-clean-scoped-46c034d7c2-20261003T0843.log, retainedcloneyzOFRa. OriginalV17 terminalRED preserved; allsavedjobs/guards unaffected. Next fullaffected requires updateda-eaudit/preflight. No sourceedit/timeoutchange/delegation/LIVE_GATE_OPS.\n\n---\n[turn:01a10103@2026-10-03T09:10:27.869Z] Current continuation native01a10103 originalsu SELF/AUTO P010. No startup/Git sourcechange or rootclose: currentrootthreads reviewed and UNKNOWN preserved. Independent tutorial unit nowcomplete: isolated Chromium11PASS0skip native69376terminalexit0/drained, cleanLOCAL20671548 exact46c034. R11manual23597 CURRENT; twelvebrowserbindings23598..23609 CURRENT plus restored unchanged163PASS unit/integration23610..23616 CURRENT; mutation23574/575CURRENT. No repoedit/nativejobpending. Fullcurrent cohort readback /tmp/cloud-tutorial-p010-restored-cohort-readback-20261003T0943.json. Clone46c034-yzOFRa disappeared afterrun, originUNKNOWN; do notuse/replay. Next manualnativea11y thenfresh a-e audit/committedpreflight/fullaffected context. HistoricalV17 terminalRED retained. R14 provenancewall unchanged/originalAvi convpendingnotsolework; no delegation/LIVE_GATE_OPS/newactivation. Preserve everyexistingitem/loopcheck.\n\n---\nFire228 currentSELFholder verified; no native-openstage/rootmeasurement, startupcauseUNKNOWN. Existinglifecycle/telemetryguards remainseparatelyverified. IndependentP010clean0c6 proof11Chromium+17suites167PASS0skip/19bindingsCURRENT refs4837/ownerfactfinding:cloud-tutorial-p010-clean-0c6-proof. Native70532/12130drained0/nojobs/sourceedits/newaffected. Nextfresha-eaudit/preflight beforecurrentaffectedcontext/noLIVE_GATE_OPS/delegation.\n\n---\nContinuation229 native01a1017b verified ORIGINAL SELF/AUTO/current P010. Clean0c6caccd77 retained cloneEoxI8Z exists/clean;15 reviewed source paths+Guide test match canonical. New motion native7620 terminalexit0 fullydrained: two13PASS0skip baselines20685783/20686058, privateoverlay semantic mutant20686155 1FAIL12PASS at instant-vs-smooth assertion; sourcebyteintegrity VERIFIED. Unique runGroup cloud-tutorial-p010-motion-fire229. R11 reviewpost1157316 assesses Guide focus restoration and shared LazyDetails optional Radix summaryRef; binding23681 CURRENT. Fresh motion23682/23683 CURRENT on same-clause readback. Exact stale unit/integration23611/23612/23613/23614/23616 retracted after replacements23668/23669/23670/23671/23673 verified; unchanged current23610/23615 preserved. Exact oldmotion23574/23575 and manual23597 retracted after23682/23683/23681 CURRENT. Evidence /tmp/cloud-tutorial-p010-*-fire229.json and motionlog/tmp/cloud-tutorial-p010-current-guide-motion-control-0c6caccd77-fire229.log. P010 remainsOPEN; NO fullaffected rerun, shipment, rootcauseclose or repoedit. Nativebeginner review remains manual-current-tree/HMRlimited. HistoricalV17RED/startup5773/EI249226/browser248097/Git5884 UNKNOWN retained. R14 authenticatedhumanprovenance wall and genuineAvi conv-murpuwd0-0000-088c795283714b3793806199794bed03 unchanged. All4/10/9 itemchecks and12loopchecks retained. Five queued ptool read handles7031/61942/8030/67286/85484 finishedexit0/drained; nojobs pending. CLI install-reader recurrence capturedEI24957207184390914 possibleduplicateEI24955907194057191; no install intervention. Stage3170 brieflyrefused then health22b7fb6afd up with binder bytes equal0c6. NEXT fresha-eharnessaudit/preflight then exactlyone currentaffected startup/Gitcontext; no delegation/LIVE_GATE_OPS/activation/unchangedR14retry. Prior fact motion/manual outstanding is superseded by this measured completedunit.\n\n---\nContinuation230 native01a1018c verified ORIGINAL su-fc5749a7/SELF/AUTO P010/current holder; complete recovery once deliberately read for omitted agenda. All6 claims retained, automatic filelocks VERIFIED. Current-a-e audit parentpost1157338; exact ledger fingerprint exit:608d73f8c68b covered supplemental audit (receipt /tmp/cloud-tutorial-p010-audit-fingerprint-fire230.json). Initial dry launch REFUSED before execution; friction coalescedEI24912689039107273, no testRED. Corrected dry task0musbxjyk8um2pq6xv2 TERMINAL completed/exit0, full17requested17matched0executed at immutableb96bf009ba8230f3e47e676ddabd0c4c92c856c5; source20selector plus17suites/43uniquepaths byteidenticalgitshow, metadata /tmp/cloud-tutorial-p010-preconditions-fire230.json. Fresh REAL17suitepreflight+3guardjob task0musbzzsgmwivn4k2u9/bash e0f9b35c-96a LAUNCHED once, deadline2026-10-03T12:01:28.292Z; unique logs /tmp/cloud-tutorial-p010-v18-preflight-full-fire230.log and -guards-fire230.log. Read only durable task_id; NEVER replay completed dry/V17/fire229 or doublelaunchfull. NO affectedv18 launched yet. Preserve completed229clean0c6 browser11/17suite167/motion13+13caughtmutant20686155 and CURRENT19bindings+manual23681/motion23682/383; earlierfield pins in4837 and ownerfact. HistoricalV17RED/full8filecensus and startup5773/EI249226/browser248097/Git5884 UNKNOWN, currenthandshake/lifecycleproof only. All4/10/9itemchecks and12loopchecks OMITTED intentionally to PRESERVE. R14humanprovenance/genuineAvi conv-murpuwd0-0000-088c795283714b3793806199794bed03 pending, notsolework. No sourceedit/delegation/LIVE_GATE_OPS/activation/unchangedR14retry. NEXT collect SAME realpreflight terminal/matched17counts/exactcleanLOCALledgers, require3guardPASS and unchangednamedbytes; onlythen exactlyone newcurrentv18 fullaffected startupGitcontext under2700000ms budget with uniqueexclusive log. Native session is successor01a1018c, not229predecessor; old supersededcarry notice is not proof this newjobfailed.\n\n---\nFire230 native01a1018c ORIGINAL su-fc5749a7 SELF/AUTO P010 reverified; omittedagenda required exactlyone liveorient, control36/automaticlocks verified. Fulla-eaudit1157338 plus exactexit:608d73f8c68b note (audit-fingerprint-fire230) recorded, backed3priorV15/V16/V17 ledger. Drytask0musbxjyk8um2pq6xv2 terminal0/17matched0executed; neverreplay. Realfirst17preflight task0musbzzsgmwivn4k2u9 TERMINALRED11:54:13Z/exit1 atb96bf009ba, full17requested=executed=matched17,1existingdocumentedskip;15suitesPASS, governor enforcement/stateFAIL3assertions. Exact cleanLOCAL20695000..16/red20695010/11/rootOmOZD9. Unique /tmp/cloud-tutorial-p010-v18-preflight-full-fire230.log;3guardsDIDNOTRUN duefail. NOv18affectedlaunched. Rootsole stale registry211vs210: migratedfrozen-driftadapter awaits runGitBatch, oldspawnSync bypassentry persisted. OwnedWI10005974 created+assignedSELF beforeedit, exactobsolete7lineregistry deleted viaautomaticlock in canonical scripts/check-resource-governor-enforcement.mjs. Nativefocused0muscabi8aglprt1d38 TERMINALcompleted0/45PASS0skip/realCLI8/8ENFORCED; localprovenanceUNKNOWN dueHEADb794->c0cb/dirtyLOCAL20695677/78 (do NOTcall clean). Fix nowCOMMITTEDc0cb9cb90ed2e46529f552ccb2aba1b027242ce1, exact45source/testpaths canonicalbyteidenticalgitshow. NEWfreshimmutablefixed17preflight+3guards task0musccrtl12f7vhbp7e LAUNCHEDonce/running, deadline12:11:24.520Z; unique /tmp/cloud-tutorial-p010-v18-preflight-full-fixed-fire230.log and -guards-fixed-fire230.log, request/meta -preflight-fixed-request-fire230.json/-preconditions-fixed-fire230.json. NEVERrelaunch whilelive. WI5974 stillWIPpendingcleanproof/normalclosure. Sourcefix only GATE_SYSTEM_DEV, noLIVE_GATE_OPS/frozenroutine/queue mutation. Postparent115? exactred-disposition receipt saved/tmp/cloud-tutorial-p010-preflight-red-disposition-fire230.json. Allother229motion/manual/browserproofretained; no replay7620/70532/12130/V17. HistoricalV17RED/startup5773/EI249226/browser248097/Git5884UNKNOWN remain despitecurrentfocusedPASS. R14humanprovenance/genuineAvi conv-murpuwd0-0000-088c795283714b3793806199794bed03 unchanged/notsolework. All4/10/9itemchecks+12loopchecks preservedbyOMISSION. FrictioncoalescedEI24912689039107273;installrecurrenceexistingEI249572; no installbypass/delegation/activation/unchangedR14retry. NEXT SAMEfixedjobterminal17matched/counts/skip +3guardPASS, exactcleanLOCALpin sourceproof then closeWI5974 normally. Onlyafterthat exactlyONEnewfullaffected startupGitcontext, exclusivev18log,2700000msdeadline; no prep repeats solelyreconstructproof. Currentnative01a1018c verified; priorcarry-dropwarning superseded(oldboundary), notthisjobfailure.\n\n---\nFire230 FINAL cleanunit/native01a1018c originalSELF/AUTO. WI10005974 NORMALDONE/committedfinishcomplete after obsolete7linefrozen-driftspawn bypass retired; rootpre/postguardverification storedcompletion, exactclean20695703/702 andlocal45PASS. FixCOMMITTEDc0cb9cb90e. Freshfull17suite492PASS1existingdocumentedA003skip, requested=executed=matched17, cleanLOCAL20695696..20695712/rootgzrFuF; /tmp/cloud-tutorial-p010-preflight-fixed-ledger-scoped-fire230.json plus -v18-preflight-full-fixed-fire230.log. Separate3guardphase atSAMEpin: resource-governor andno-rawgoalPASS, generatedtool-deliverycheckFAILSTALE; SAMEtask0musccrtl12f7vhbp7e terminalRED12:06:16Z/exit1 fullyreadback. Unique -v18-preflight-guards-fixed-fire230.log/rootxHPTxo. NOjobs pending/NOfullaffectedv18LAUNCHED; neverreplayterminaltask orcompleted17proof. Newownedgeneratorresidue WI-10005977 created+selfassignedimmediately; deltaoriginUNKNOWN, inspectmaintainedgeneratorcurrentdiff next. Previous5883/5974DONE neverrework. Fullpreflightfirstb96RED(staleregistry211/210) retainedexactrows20695000..16/red10/11. Fullfixed17PASSdoesNOTmakewhole3guardpreflightPASS. Needednext: diagnose WI-10005977, regenerate/reviewcanonicalmap withunchanged100000Bceilings, selectivelyverifyinvalidatedseed/generatorproof undercurrentcleanpin then updatedattemptauditBEFOREexactlyONEfullaffectedstartupGitcontext. Avoidre-runningunchanged17matrixsolelyreconstructproof. Nativeallcallsdrained; local45proofUNKNOWNHEADmovementcorrectedbyclean17guardproof. All6heldcheckpointand12loopchecks/4/10/9itemrows preservedbyOMISSION. OriginalV17RED/historicalstartup5773/EI249226/browser248097/Git5884UNKNOWN remain; motion/manual/browser229proofretained; genuineAvi conv-murpuwd0-0000-088c795283714b3793806199794bed03/R14humanprovenanceunchangednotsolework. NoLIVE_GATE_OPS/frozenroutine/queueaction/delegation/activation/unchangedR14retry. Context90%cleanatomicstop: carryrespawnNOWbeforegeneratornewsubtask. Originalpriorcarrydropwarningisold/superseded; newnative01a1018c verified.",
            "source": "checkpoint carry-note ## Next action"
          },
          "blockers": {
            "status": "known",
            "value": [],
            "source": "workItem.payload external blockers (active)"
          }
        },
        {
          "id": "EI-24870209437597571",
          "next": {
            "status": "known",
            "value": "Request same-session managed compaction using saved parent/main/loop anchors, then verify request receipt. Successor must verify originalowner and attach SAME affectedv13 job. Do not arm another loop or restart the full test.\n\n---\nFresh native01a0ff35 originalowner verified; same existing cold60 loop active, socketreachable andrewakeGuaranteedtrue at00:55Z. This is current delivery state, not a resolution of the original warm/noPID root. All ownjobs terminal; managedcleanboundary requested, no secondloop/rearm or new monitoring lane.",
            "source": "checkpoint carry-note ## Next action"
          },
          "blockers": {
            "status": "known",
            "value": [],
            "source": "workItem.payload external blockers (active)"
          }
        },
        {
          "id": "EI-24923992688505913",
          "next": {
            "status": "known",
            "value": "Continue bounded instrumented diagnosis/disposition for5773; no blind repeated narrow baselines or fullaffected until responsible root disposition and requiredpostV14a-eaudit/exactcommittedpreflight. Need consider concrete discriminating controlledrealnative experiment or explicit ownedunknown-root disposition, not invent explanation. Read owneranswer and sameheadedpilot launch references if available; do not self-answer. SELF/AUTO/cold60, noLIVE_GATE_OPS/delegation/source-cloneedits.\n\n---\nNative01a0ffb3 current: unchanged5s timeout/no bump. UNKNOWNstartuproot disposition1156663 remains owned5773. Exact4suite clean preflight99PASS1existingSkip20616329..32 at1f903c8a968b843810353dc86d05626454b8bdf6; samepin affectedV15 task0murtdzbq1kaqc701yp RUNNING03:11Z/log/tmp/cloud-tutorial-explicit-affected-current-v15.log/deadline03:55:28Z. No historicalcause attribution; retainOPENpending realstage evidence.\n\n---\n2026-10-03T03:31Z native01a0ffc2/currentoriginalsu: SAME V15 task0murtdzbq1kaqc701yp remainsRUNNING03:30Z/processidentity+cgroup; log31464B/mtime03:30:07, deadline03:55:28.158Z. Completed statefulleg exit1/586s complete2files: tracked-files-helper.test.ts falsepositive restricted-tree prose, watch.test.ts missing findMatchingActiveStandingWatch in committedmock; total3assertionsfailed,1538filespass11skipped/31003testsPASS45skip3todo. Actual A003 full5cases4PASS1existingSkip137ms in SAME V15; NOhistoricalstartuprootresolutioninference. NativeUNKNOWNWI5773/EI249226 and clean20610306/20611473/474 intact. Watch root ALREADY DONE WI10005697 atcurrent190aaa/2c21 receipts; pin1f903 oldmock, currentdiff includes realfakeStore/finder/tests and prior33PASS20615063; do notredo. NewfalsepositiveROOT WI10005805 createdselfWIP, fixed canonicaltracked-files-helper detector by reusing existing mask/liveanchorhelpers, strengthened read/filter/livecall controls; final full29PASS0skip20622400/localdirtytrue at3ae030, sourceblobe9af65d77fc926c6a662c156b81678ddd4876419. 5805 CLOSEDdone finishcomplete:true/authorityproposed, exactlast3linechange awaitingauto git-syncsettlement; doNOTreclose/retest solelytoquerysettlement. Existing WI5778 ownedlive4f968 has guardfailure1156693; peerreported treefix canonicalholder/guard0/118PASS via injectedmessage, not independently cleanproof. No LIVE_GATE_OPS/delegation/timeoutchanges/quarantine/cloneSOURCEedits. coord:orient deliberatelyread currentcodexLocks only: AUTOMATICverified generation1790994641000; no manualper-editlocks. Nativeedits complete, automaticapplyreturned{}, fullsuiteactuallypassed. Acceptancecurrentplan77/rubric9 reviewed: R13 requires exactpromotedartifact/login/P012; R14 stale@4 workcontract vs current@5 and proof requires genuineAvi authorshipresponse. CurrentconvOPEN/null/posts[]03:24Z; pending, no selfanswer/reask/grader. No new affectedlaunch. Preserve separate2/8/7checkrows,12loopchecks. NextattachsameV15 then fullterminalcensus,exactcleanproof+mandatoryaudit before nextexpensiveretry.\n\n---\n[turn:01a0ffe3@2026-10-03T03:52:08.217Z] Read current open/self-assigned item and its saved evidence. No change to the fixed5s override or any timeout. Historical startup-delay cause remains UNKNOWN under WI5773/EI249226. Supersedes old running-V15 follow-up: V15 terminal RED; current sole required V16 task_id 0murumlm21npqwyq1qv running at exact5a907e1ffe, deadline2026-10-03T04:30:09.908Z. Attach same task; details and all check ledgers retained in current root/parent/main and loop checkpoint6fa0398d8ca0.\n\n---\n2026-10-03T05:52Z recovery delta supersedes carried RUNNING preflight. Original su-fc5749a7 verified; SELF/AUTO control29/hashb00c482a, same P010 held, automatic verified locks. Existing task0murypuyb6e28xufvso terminalCOMPLETED/exit0, no relaunch: pinb87b1bc2059c2bc5b40681610ac892b575d16270 full6 suites260PASS0skip, requested/executed/matched6/6, pre/post named0dirty/unknown/STAMPED. Actual exact-root LOCAL receipts20638267..20638272 allPASS/worktreeDirty=false at same pin (root/tmp/papercusp-lint-as-committed-b87b1bc205-NjitxE). Both committed guards PASS/rootfqFhg1; complete dry/full/guards logs /tmp/cloud-tutorial-v17-preflight-b87b1bc2059c-{dry,full,guards}.log. Post1156846 stores counts75/17/51/9/36/72 and scope. Dry executed0 is routing only.\nFailed PRE-EXECUTION V17 setup wrapper task0murz3f1j120ztai1c0/bash1f459ccc-e6b ended exit1 at05:50:13Z BEFORE npm or any test and BEFORE creating v17.log. Caller shlex parsed every raw V16 log line and hit an unmatched quote; actual tool/runner terminal receipt .papercusp/scratch/bash-1f459ccc-e6b.log confirms no test launch. Friction captured via improvements:capture observation. Corrected extraction VERIFIED read-only: first select the sole line starting '> node scripts/lint-as-committed.mjs test:affected ' from preserved /tmp/cloud-tutorial-explicit-affected-current-v16.log, THEN shlex.split only that command line, require exactly1 --changed-paths= token/20unique operands. Do NOT shlex arbitrary log output. No actual V17 affected test has executed; do not treat failed setup as testRED or rerun preflight.\nNext AFTER native compaction (current64% exceeds prior60% new-unit ceiling): verify originalidentity, preserve every3/9/8 separate itemcheck and12loopchecks, then at most ONE actual broadV17 at SAME b87b1bc205 pin/original20selector under post-V16 audit1156760. Reuse maintained npm run lint:as-committed -- test:affected --any --ref=<pin> --keep -- --related <exactselector>, unique /tmp/cloud-tutorial-explicit-affected-current-v17.log; refuse overwriting any existing log. Keep2700000ms wrapper deadline budget unchanged. Before launch validate canonical staging,20operands plus11preflight source/test blobs match git show pin:path, prior fullTEST_FILE_RESULT6/6passed and bothguardPASS; no cloneSOURCEedit, timeout/baseline change, delegation or LIVE_GATE_OPS. Do not reattach oldsetup as running or doublelaunch. WholeWI5802DONE dependency withdrawn1156825; its tutorialsidefixcomplete, separatemainOPEN not ourblocker. Genuine Avi conversation conv-murpuwd0-0000-088c795283714b3793806199794bed03/wait222019 remains pending; no reask/selfanswer. Historical V16RED and original A003 startupUNKNOWN WI5773/EI249226 remain; currentPASS cannot establish historical root fix, affectedPASS or shipment. P010/P012/ship remainOPEN.\n\n---\nV17 actual launch (not the previous setup wrapper), 2026-10-03T06:00Z: original su-fc5749a7 verified and P010 alreadyHeld; SELF/AUTO control29 with verified automatic locks. Recovered exact prior launch arguments from native predecessor transcript; saved command-line-only extraction yields1 command,1 selector,20unique operands. Read-only canonical precheck and launch both verified staging root,20selector files plus11 preflight sources/tests byte-identical to immutable b87b1bc2059c2bc5b40681610ac892b575d16270, six-suite full requested/executed/matched6/6 PASS and both committed guards PASS. V17 unique log did not exist and opened exclusively. Actual capability:bash task_id0murzgxsa4oy0qui3lq/bash61cffc54-dc5 launched once with2700000ms deadline2026-10-03T06:45:43.823Z; work-item WI10005128. Initial output V17_PINNED_PRECONDITIONS_PASS, unique /tmp/cloud-tutorial-explicit-affected-current-v17.log contains maintained npm test:affected start and pc-heavy slot acquired. Current same-task liveness process_identity_and_cgroup confirms RUNNING; full child /tmp/pcv/papercusp-affected-tests/4159958-c466cd68.log. No verdict yet. ONLY reattach this task_id, never relaunch. Original failedsetup0murz3 and terminalpreflight0murypuy are not running. Post-V16audit1156760 and corrected dependency1156825 govern. Preserve all original3/9/8 item checks and12loop checks, preflight260PASS scope, historicalV16RED/startupUNKNOWN WI5773/EI249226/browser248097, and genuine Avi conv-murpuwd0/wait222019. No LIVE_GATE_OPS, delegation, timeout/baseline changes or clone source edits. Next: wait on this owned active process at bounded cadence, capture terminal JOB END/exit and complete task/file census with actual clean exact-root LOCAL ledgers before any conclusion. No extra full or focused reruns to reconstruct already saved proof.\n\n---\nContinuation recovery verified original su-fc5749a7 via coord:whoami and P010 alreadyHeld. Actual V17 task0murzgxsa4oy0qui3lq/bash61cffc54-dc5 is RUNNING by fresh process_identity_and_cgroup (pid52688/scopepc-0murzgxsa4oy0qui3lq.service); never relaunch. Unique /tmp/cloud-tutorial-explicit-affected-current-v17.log shows stateful elapsed480s/captured1459100B/stalled0, agent-mcp finished81s exit0, web test started; no terminal verdict. Full child /tmp/pcv/papercusp-affected-tests/4159958-c466cd68.log, exact materialization /tmp/papercusp-lint-as-committed-b87b1bc205-RTfIGr, immutableb87b1bc2059c2bc5b40681610ac892b575d16270, original20selector and deadline2026-10-03T06:45:43.823Z unchanged. Read actual affected writer terminal-result/failing-file semantics in pinned tree before any future count/verdict. Saved whole source checkpoint available at /home/marsh-office/.papercusp/scratch/papercusp-workspace/work_items:get/6076b60a-d8da-4df4-80ed-acd8bfa47b3a/result-door-1791007831970.md; main full10check rows and5773/main/parent counts4/10/9 recovered. AUTO/SELF bounded120s cold workloop active, max2700s/24fires; original Avi conversation await persists. Own open directives0. No repo edits, new tests, LIVE_GATE_OPS, delegation, timeout/baseline changes or clone source edits. Next only reattach V17 at bounded wake; on terminal get JOB END/exit and full task/failing-file census plus exact-root CLEAN LOCAL ledger rows, then disposition permitted work. Preserve audit1156760/correction1156825, preflight260PASS scope, historicalV16RED, historicalstartupUNKNOWN5773/EI249226 and browser248097UNKNOWN. P010/P012/ship OPEN; genuine Avi conv-murpuwd0-0000-088c795283714b3793806199794bed03/wait222019 remains pending. End loop once only genuine Avi human acceptance remains.\n\n---\n[turn:01a1005c@2026-10-03T06:13:31.215Z] V17 PARTIAL stateful result, not overall verdict: originalidentityverified; same task0murzgxsa4oy0qui3lq RUNNING by fresh process_identity_and_cgroup, no relaunch. Unique/tmp/cloud-tutorial-explicit-affected-current-v17.log stateful finished775s exit1; pure300s/349604B/stalled1, operator-vite240s/18183B/stalled0, other tasks continue. Fullstatefuloutput in child4159958-c466cd68 has exactly3failedfiles: claude/omp seed-wire-budget assertions100372B>unchanged100000B and git-sync/run-git-sync-progress queued-output-before-idle assertion. ExactcleanLOCAL rows20643586/20643549/20644423 allworktreeDirtyfalse/b87b1bc2059c2bc5b40681610ac892b575d16270/root/tmp/papercusp-lint-as-committed-b87b1bc205-RTfIGr. This is PARTIAL task evidence; fulltask/failingfilecensus stillpending. Newboundedsourcefollowups WI-10005883(seed pair, relatesdone5434/olderopen4913) and WI-10005884(Git progress) CREATED+ASSIGNED ORIGINALSELF; rootsUNKNOWN until distinguishing measurement, nofixclaim. No newtests/sourceedit/delegation/LIVE_GATE_OPS/timeout/baselineorcloneSOURCEchanges. Otherpreviouswork remainsopen including5814guards untilterminalresidueaccounted. AUTO/SELFcontrol30 unchanged. Read stale wake recovery and predecessor3turntail; currentlive evidence supersedescarryd4d3c4d749dc; lastloopnote81c38ea1e25f wasnewer. Read fulldirectednovicefollowupmessage coord-send-6e03f96178e8082cdf6806e619e8a457c3893a7ee6c1c782eda0d4eade4ad761 and ACKreceiptmus02379; siblingWI10005831 is peer-owned distinctscope, do not supervise. Current67-79% exceedsinherited60%nextunitceiling; flushandcompaction atthisboundary, preserveactivejob. Next verifyoriginalwhoami, reattachONLYactualV17; waitboundeduntilterminaldeadline2026-10-03T06:45:43.823Z, thencompleteJOBEND/exit/task+filecensus/exactcleanLOCALledgerlookup beforeoverallconclusion. Preserveall4/10/9 itemchecks/12loopchecks, audits1156760/correction1156825, preflight260PASSscope/historicalV16RED/startupUNKNOWN5773/EI249226/browser248097, genuineAvi conv-murpuwd0-0000-088c795283714b3793806199794bed03/wait222019. P010/P012/SHIPOPEN. Onceonlygenuinehumanwaitremains endworkloop.\n\n---\n[turn:01a1005c@2026-10-03T06:24:21.713Z] Delayed loopwake carried81c38ea1e25f, superseded by current99e3785a4075 and parentpost1156886. Original su-fc5749a7 verifiedagain; ONLY actualV17task0murzgxsa4oy0qui3lq remainsRUNNING. Current uniquev17log pure540s/766384B/stalled5; operator-vitefinished428sexit0. Historical completedstateful3failedfiles andowned5883/5884 remain; fulloverallcensusPENDING. No relaunch/sourceedit/testretry/LIVE_GATE_OPS/delegation/timeoutbaselinechange. Samepinb87b1bc205/rootRTfIGr/original20selector/deadline06:45:43.823Z. Allsaved4/10/9itemchecksand12loopchecks preserve; genuineAviwaitandstartupUNKNOWNremain. Compaction re-request atcleanboundary; successoronlyreattachandcollectterminalfullcensusbeforeconclusion.\n\n---\n2026-10-03 native01a100c3 continuation originalsu/currentholder verified. No timeout/concurrency/baseline change, source edit or test launch. HistoricalstartupdelayUNKNOWN; no new fullaffected. R14acceptanceauthorrepair is in-progress4837, binder untouched. Maintained isolatedaffectedroute policyverifiedALLOW only; no actualverificationrun. Preserve all previous proof/checks. Fresh a-eaudit and committedpreflight before next fullaffected. Loop788ec57f8a0a; contextsettle.\n\n---\n2026-10-03 originalsession identity/currentclaim reverified; no newstartupdelaymeasurement, timeout/concurrency/sourcechange. HistoricaldelayUNKNOWN. Current independentP010proofrepair4837 exact46c034d7c2 scoped17suites session36487 pending, samecloneyzOFRa, unique current-clean-scoped0843log. Prior unscoped163PASS0skip native22217exit0drained cannotbind; attributionrepair only. Preserve historicalaffectedterminal/logs; freshauditedcontext required before newaffected. No LIVE_GATE_OPS/delegation.\n\n---\n[turn:01a10103@2026-10-03T09:10:27.869Z] Current continuation native01a10103 originalsu SELF/AUTO P010. No startup/Git sourcechange or rootclose: currentrootthreads reviewed and UNKNOWN preserved. Independent tutorial unit nowcomplete: isolated Chromium11PASS0skip native69376terminalexit0/drained, cleanLOCAL20671548 exact46c034. R11manual23597 CURRENT; twelvebrowserbindings23598..23609 CURRENT plus restored unchanged163PASS unit/integration23610..23616 CURRENT; mutation23574/575CURRENT. No repoedit/nativejobpending. Fullcurrent cohort readback /tmp/cloud-tutorial-p010-restored-cohort-readback-20261003T0943.json. Clone46c034-yzOFRa disappeared afterrun, originUNKNOWN; do notuse/replay. Next manualnativea11y thenfresh a-e audit/committedpreflight/fullaffected context. HistoricalV17 terminalRED retained. R14 provenancewall unchanged/originalAvi convpendingnotsolework; no delegation/LIVE_GATE_OPS/newactivation. Preserve everyexistingitem/loopcheck.\n\n---\nFire228 currentSELFholder verified; no startupdelaymeasurement/timeout/concurrency/sourcechanges; historicalUNKNOWN persists. IndependentP010clean0c6 proof11Chromium+17suites167PASS0skip/19bindingsCURRENT fullrefs4837/ownerfactfinding:cloud-tutorial-p010-clean-0c6-proof. Native70532/12130drained0/nojobs. Nextfresha-eaudit/preflight beforecurrentaffectedcontext/noLIVE_GATE_OPS/delegation.\n\n---\nContinuation229 native01a1017b verified ORIGINAL SELF/AUTO/current P010. Clean0c6caccd77 retained cloneEoxI8Z exists/clean;15 reviewed source paths+Guide test match canonical. New motion native7620 terminalexit0 fullydrained: two13PASS0skip baselines20685783/20686058, privateoverlay semantic mutant20686155 1FAIL12PASS at instant-vs-smooth assertion; sourcebyteintegrity VERIFIED. Unique runGroup cloud-tutorial-p010-motion-fire229. R11 reviewpost1157316 assesses Guide focus restoration and shared LazyDetails optional Radix summaryRef; binding23681 CURRENT. Fresh motion23682/23683 CURRENT on same-clause readback. Exact stale unit/integration23611/23612/23613/23614/23616 retracted after replacements23668/23669/23670/23671/23673 verified; unchanged current23610/23615 preserved. Exact oldmotion23574/23575 and manual23597 retracted after23682/23683/23681 CURRENT. Evidence /tmp/cloud-tutorial-p010-*-fire229.json and motionlog/tmp/cloud-tutorial-p010-current-guide-motion-control-0c6caccd77-fire229.log. P010 remainsOPEN; NO fullaffected rerun, shipment, rootcauseclose or repoedit. Nativebeginner review remains manual-current-tree/HMRlimited. HistoricalV17RED/startup5773/EI249226/browser248097/Git5884 UNKNOWN retained. R14 authenticatedhumanprovenance wall and genuineAvi conv-murpuwd0-0000-088c795283714b3793806199794bed03 unchanged. All4/10/9 itemchecks and12loopchecks retained. Five queued ptool read handles7031/61942/8030/67286/85484 finishedexit0/drained; nojobs pending. CLI install-reader recurrence capturedEI24957207184390914 possibleduplicateEI24955907194057191; no install intervention. Stage3170 brieflyrefused then health22b7fb6afd up with binder bytes equal0c6. NEXT fresha-eharnessaudit/preflight then exactlyone currentaffected startup/Gitcontext; no delegation/LIVE_GATE_OPS/activation/unchangedR14retry. Prior fact motion/manual outstanding is superseded by this measured completedunit.\n\n---\nContinuation230 native01a1018c verified ORIGINAL su-fc5749a7/SELF/AUTO P010/current holder; complete recovery once deliberately read for omitted agenda. All6 claims retained, automatic filelocks VERIFIED. Current-a-e audit parentpost1157338; exact ledger fingerprint exit:608d73f8c68b covered supplemental audit (receipt /tmp/cloud-tutorial-p010-audit-fingerprint-fire230.json). Initial dry launch REFUSED before execution; friction coalescedEI24912689039107273, no testRED. Corrected dry task0musbxjyk8um2pq6xv2 TERMINAL completed/exit0, full17requested17matched0executed at immutableb96bf009ba8230f3e47e676ddabd0c4c92c856c5; source20selector plus17suites/43uniquepaths byteidenticalgitshow, metadata /tmp/cloud-tutorial-p010-preconditions-fire230.json. Fresh REAL17suitepreflight+3guardjob task0musbzzsgmwivn4k2u9/bash e0f9b35c-96a LAUNCHED once, deadline2026-10-03T12:01:28.292Z; unique logs /tmp/cloud-tutorial-p010-v18-preflight-full-fire230.log and -guards-fire230.log. Read only durable task_id; NEVER replay completed dry/V17/fire229 or doublelaunchfull. NO affectedv18 launched yet. Preserve completed229clean0c6 browser11/17suite167/motion13+13caughtmutant20686155 and CURRENT19bindings+manual23681/motion23682/383; earlierfield pins in4837 and ownerfact. HistoricalV17RED/full8filecensus and startup5773/EI249226/browser248097/Git5884 UNKNOWN, currenthandshake/lifecycleproof only. All4/10/9itemchecks and12loopchecks OMITTED intentionally to PRESERVE. R14humanprovenance/genuineAvi conv-murpuwd0-0000-088c795283714b3793806199794bed03 pending, notsolework. No sourceedit/delegation/LIVE_GATE_OPS/activation/unchangedR14retry. NEXT collect SAME realpreflight terminal/matched17counts/exactcleanLOCALledgers, require3guardPASS and unchangednamedbytes; onlythen exactlyone newcurrentv18 fullaffected startupGitcontext under2700000ms budget with uniqueexclusive log. Native session is successor01a1018c, not229predecessor; old supersededcarry notice is not proof this newjobfailed.\n\n---\nFire230 native01a1018c ORIGINAL su-fc5749a7 SELF/AUTO P010 reverified; omittedagenda required exactlyone liveorient, control36/automaticlocks verified. Fulla-eaudit1157338 plus exactexit:608d73f8c68b note (audit-fingerprint-fire230) recorded, backed3priorV15/V16/V17 ledger. Drytask0musbxjyk8um2pq6xv2 terminal0/17matched0executed; neverreplay. Realfirst17preflight task0musbzzsgmwivn4k2u9 TERMINALRED11:54:13Z/exit1 atb96bf009ba, full17requested=executed=matched17,1existingdocumentedskip;15suitesPASS, governor enforcement/stateFAIL3assertions. Exact cleanLOCAL20695000..16/red20695010/11/rootOmOZD9. Unique /tmp/cloud-tutorial-p010-v18-preflight-full-fire230.log;3guardsDIDNOTRUN duefail. NOv18affectedlaunched. Rootsole stale registry211vs210: migratedfrozen-driftadapter awaits runGitBatch, oldspawnSync bypassentry persisted. OwnedWI10005974 created+assignedSELF beforeedit, exactobsolete7lineregistry deleted viaautomaticlock in canonical scripts/check-resource-governor-enforcement.mjs. Nativefocused0muscabi8aglprt1d38 TERMINALcompleted0/45PASS0skip/realCLI8/8ENFORCED; localprovenanceUNKNOWN dueHEADb794->c0cb/dirtyLOCAL20695677/78 (do NOTcall clean). Fix nowCOMMITTEDc0cb9cb90ed2e46529f552ccb2aba1b027242ce1, exact45source/testpaths canonicalbyteidenticalgitshow. NEWfreshimmutablefixed17preflight+3guards task0musccrtl12f7vhbp7e LAUNCHEDonce/running, deadline12:11:24.520Z; unique /tmp/cloud-tutorial-p010-v18-preflight-full-fixed-fire230.log and -guards-fixed-fire230.log, request/meta -preflight-fixed-request-fire230.json/-preconditions-fixed-fire230.json. NEVERrelaunch whilelive. WI5974 stillWIPpendingcleanproof/normalclosure. Sourcefix only GATE_SYSTEM_DEV, noLIVE_GATE_OPS/frozenroutine/queue mutation. Postparent115? exactred-disposition receipt saved/tmp/cloud-tutorial-p010-preflight-red-disposition-fire230.json. Allother229motion/manual/browserproofretained; no replay7620/70532/12130/V17. HistoricalV17RED/startup5773/EI249226/browser248097/Git5884UNKNOWN remain despitecurrentfocusedPASS. R14humanprovenance/genuineAvi conv-murpuwd0-0000-088c795283714b3793806199794bed03 unchanged/notsolework. All4/10/9itemchecks+12loopchecks preservedbyOMISSION. FrictioncoalescedEI24912689039107273;installrecurrenceexistingEI249572; no installbypass/delegation/activation/unchangedR14retry. NEXT SAMEfixedjobterminal17matched/counts/skip +3guardPASS, exactcleanLOCALpin sourceproof then closeWI5974 normally. Onlyafterthat exactlyONEnewfullaffected startupGitcontext, exclusivev18log,2700000msdeadline; no prep repeats solelyreconstructproof. Currentnative01a1018c verified; priorcarry-dropwarning superseded(oldboundary), notthisjobfailure.\n\n---\nFire230 FINAL cleanunit/native01a1018c originalSELF/AUTO. WI10005974 NORMALDONE/committedfinishcomplete after obsolete7linefrozen-driftspawn bypass retired; rootpre/postguardverification storedcompletion, exactclean20695703/702 andlocal45PASS. FixCOMMITTEDc0cb9cb90e. Freshfull17suite492PASS1existingdocumentedA003skip, requested=executed=matched17, cleanLOCAL20695696..20695712/rootgzrFuF; /tmp/cloud-tutorial-p010-preflight-fixed-ledger-scoped-fire230.json plus -v18-preflight-full-fixed-fire230.log. Separate3guardphase atSAMEpin: resource-governor andno-rawgoalPASS, generatedtool-deliverycheckFAILSTALE; SAMEtask0musccrtl12f7vhbp7e terminalRED12:06:16Z/exit1 fullyreadback. Unique -v18-preflight-guards-fixed-fire230.log/rootxHPTxo. NOjobs pending/NOfullaffectedv18LAUNCHED; neverreplayterminaltask orcompleted17proof. Newownedgeneratorresidue WI-10005977 created+selfassignedimmediately; deltaoriginUNKNOWN, inspectmaintainedgeneratorcurrentdiff next. Previous5883/5974DONE neverrework. Fullpreflightfirstb96RED(staleregistry211/210) retainedexactrows20695000..16/red10/11. Fullfixed17PASSdoesNOTmakewhole3guardpreflightPASS. Needednext: diagnose WI-10005977, regenerate/reviewcanonicalmap withunchanged100000Bceilings, selectivelyverifyinvalidatedseed/generatorproof undercurrentcleanpin then updatedattemptauditBEFOREexactlyONEfullaffectedstartupGitcontext. Avoidre-runningunchanged17matrixsolelyreconstructproof. Nativeallcallsdrained; local45proofUNKNOWNHEADmovementcorrectedbyclean17guardproof. All6heldcheckpointand12loopchecks/4/10/9itemrows preservedbyOMISSION. OriginalV17RED/historicalstartup5773/EI249226/browser248097/Git5884UNKNOWN remain; motion/manual/browser229proofretained; genuineAvi conv-murpuwd0-0000-088c795283714b3793806199794bed03/R14humanprovenanceunchangednotsolework. NoLIVE_GATE_OPS/frozenroutine/queueaction/delegation/activation/unchangedR14retry. Context90%cleanatomicstop: carryrespawnNOWbeforegeneratornewsubtask. Originalpriorcarrydropwarningisold/superseded; newnative01a1018c verified.\n\n---\nFire231 original su-fc5749a7 native01a101b0 verified; control38 SELF/AUTO/cold120. Recovery resynced exactlyonce for hash mismatch. Liveorient spill confirms automatic lockMode verified generation1791028677000; subsequent edits must rely on hook, not manual per-edit locks. WI10005977 NORMALDONE/committed/finishcomplete after maintained generator regeneration atb87a8b045b8badd0326f257e2e7ef53888efa2e8, unchanged100000B budgets and64names/floors, mapsha5add0e6d4d4ab81282407616ec48db792f1d18dc64ca75f2b4a1c99165c11ef1. Clean3complete seed/drift suites26PASS0skip rows20699691/692/693/root5yDp0o; clean generatorcheckPASS/slh06S; task0musd6d041ntfountfb TERMINALcompleted/exit0 12:29:57Z. Logs /tmp/cloud-tutorial-p010-generator-{report,reviewed-diff,seed-clean,guard-clean,clean-exact-ledger,complete}-fire231.*. Completed fire23017suite492PASS1documentedskip retains exact20695696..712/rootgzrFuF;43named paths match b87a; only map+affectedrouter changedsincec0cb (routerintegration-only unused). Parent fresha-eaudit1157386 plus exacttwo-fingerprint correction1157388 namesexit:608d73f8c68b andlog:f0886bfb74fa (existing documented A003skip marker inferred asfailure). Refused firstguardlaunch NOJOB, frictioncoalescedEI24912689039107273. SAMEremaining2guard task0musditer8bwlh113bf RUNNING deadline12:39:06Z, /tmp/cloud-tutorial-p010-v18-remaining-guards-fire231.log; neverdoublelaunch. FULLaffectedv18 NOTLAUNCHED. Incidental dirtylocalGC row20699686 unconfirmed filed+selfownedWI10005979; unrelatedto generatorcompletion, diagnoseonlyafteroriginalscope or actual dependency. 5974/5883/5977terminalneverrework. All4/10/9itemrows and12loopchecks preservedbyomission; originalV17RED andstartup5773/EI249226/browser248097/Git5884UNKNOWN, motion/manual/browser229proof and genuineAvi/R14wall retained. NoLIVE_GATE_OPS/frozenqueue/delegation/activation/R14retry. Carrydropwarning refers supersededoldpredecessor; THISnative01a101b0live.\n\nNEXT: Read SAMEremainingguard0musditer8bwlh113bf terminal+log; on2PASS and43pathparitylaunch exactlyONE immutableb87a original20selector fullaffectedv18, uniquev18-fire231log,2700000ms deadline. Do not rerun completed17/seed/gen/V17. If newfingerprint refuses, read+name currentledgerkey withactualcause before retry; no inventedroot. Then persisttaskid/log/deadline andcontinue bounded ownerverification.\n\n---\nFire231 FINAL clean atomic boundary: remaining2guard task0musditer8bwlh113bf TERMINALcompleted/exit0 at12:35:24Z, exactb87a8b045b8badd0326f257e2e7ef53888efa2e8/rootzX0eqX, resource-governor and no-raw-goal PASS. Readback /tmp/cloud-tutorial-p010-v18-remaining-guards-terminal-fire231.json and log. Generatedcheck SAMEpinPASS/slh06S plus3suites26PASS0skip exactcleanLOCAL20699691..693/root5yDp0o. WI10005977 NORMALDONEcommittedfinishcomplete, neverrework. Entire preconditions now satisfied using retained17suite492PASS1documentedskip c0cbproof + selectivelyinvalidated26seed/driftproof +3currentb87aguardsPASS. ALLjobs terminal; NOFULLaffectedv18LAUNCHED. Exactlyone new fullaffected startup/Git context next using original20selector in /tmp/cloud-tutorial-p010-preconditions-fire231.json, immutableb87a, exclusive /tmp/cloud-tutorial-explicit-affected-current-v18-fire231.log,2700000ms deadline. Audit1157386/1157388 namesboth exit:608d73f8c68b andlog:f0886bfb74fa (existing documentedskipmarker, no assertionfailure). No oldtask/preflightcohort replay. Native01a101b0originalidentity currentreverified; stale carrydropwarningoldpredecessor, not thisboundary. Currentloophas120coldboundedwake; preserveall12loopchecks and4/10/9existingitemrowsbyomission. OriginalV17RED/startup5773/EI249226/browser248097/Git5884UNKNOWN, prior229browser/manual/motionproof andgenuineAvi/R14 wall unchanged. Incidentaldirty…[older checkpoint content truncated]…\n\n\n---\n[turn:01a101c9@2026-10-03T12:52:52.362Z] Fire233 clean atomic boundary: original SELF/AUTO/native01a101c9 identity/current parent claims verified. V18 task0muse11gczw9w4213if TERMINAL REFUSED innerexit78/wrapper1 at12:51:05Z;34derived,0started/finished/failed/timedout,34undetermined. Not testRED/PASS; never replay/resumev18. Fullunique /tmp/cloud-tutorial-explicit-affected-current-v18-fire231.log + inner1338285-117bd629.log and terminal-fire233.json retained. DirectSELFowned EI24963110722421909 sourceorigin: scheduler summed historical3451886ms aswalllowerbound against2531239remaining despite2concurrentlanes. Reused existing estimateBudgetedTaskWallMs forwhole-plan/per-shard checks; diagnostic/declarationdocs now truthful; canonicalparallelfit, serial andsequentialshardcontrols. 4changedpaths: scripts/lib/budgeted-task-scheduler.mjs/.d.mts, scripts/affected-tests.mjs, packages/operator-core/lib/__tests__/affected-tests-deadline-admission.test.ts. Actualbefore fullsuite10PASS1FAIL0skip (parallelfit caught withfalse120000refusal), task0musefv6yl4pzr8vwp2 terminalexit1. SAMEaftertask0musej6491omk9ly1jq TERMINALcompletedexit0, full2canonical suites12+93=105PASS0skip, requested/executed/matched2; currentLOCALdirty stamped at a83332218a, NOTcleancommit proof. Logs -deadline-before/after-fire233.log, receipts -deadline-before/after-*-fire233.*. ALLjobs nowterminal; nofullv19launched. EIrootfixWIPpendingcleancommitproof/normalclose, no widenedtimeouts/budgets/concurrency/skips. Prior492PASS1existing documentedskip, clean26seed and3guards, fire229browser/manual/motion proof retained scoped; originalstartup5773/EI249226/browser248097/Git5884UNKNOWN and genuineAvi/R14wall unchanged. All4/10/9itemchecks+12loopchecks preservedbyomission. WI5977DONEneverrework; incidental5979ownedunconfirmed/no parallelmission. NoLIVE_GATE_OPS/delegation/activation/unchangedR14retry. Context88% cleanunit: requestmanagedcompactionNOWbefore cleanproof/newfullrun. Carrydropwarning refers supersededoldpredecessor; notthisjobfailure.",
            "source": "checkpoint carry-note ## Next action"
          },
          "blockers": {
            "status": "known",
            "value": [],
            "source": "workItem.payload external blockers (active)"
          }
        }
      ],
      "originalReviewedWorkRefs": [
        "EI-24922683639239432",
        "EI-24870209437597571",
        "EI-24923992688505913"
      ],
      "sourceScope": [
        "census.json",
        "review-data.json",
        "loops-8.json"
      ],
      "stepApplicabilityAssessment": "Tutorial handoff does not explicitly dispose of the three independently named EI rows. Two retain native-latency diagnosis next steps; one retains managed-compaction/receipt next step. Source map names only three held references while frozen count is four; resolve full held set and dated applicability.",
      "controlApplicability": "review-open",
      "cutoffAssignment": "review-open",
      "eligibilityAccepted": false,
      "sourceSnapshotCardinality": {
        "frozenClaimCount": 4,
        "namedReviewedWorkRefs": 3,
        "sameInstantEqualityEstablished": false
      },
      "independentSourceRow": 104
    }
  ],
  "original018": {
    "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold57-held-item-step-applicability-source-424d5.json#/original018",
    "assessment": "Checkpoint35083319 positively records audit row89 remaining under WI-10006302 separately from EI release:deployed recurrence. Prior reviewed audit step is conditional on settled cycle, active await254510, zero outstanding deliveries and guaranteed wake. Four later directional release witnesses preserve each original item identity; they do not certify exact-cutoff assignment/actionability or exhaustive controls. No whole-owner exclusion or eligibility accepted.",
    "independentSourceRow": 0
  },
  "independentReviewIndex": [
    {
      "ownerId": "su-01864986-d27d-497b-b501-7082b6e0caab",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/0",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/0",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/0",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-079b1c14-07ec-495e-b640-6a60f89180e2",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/1",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/1",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/1",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-07eba67b-e1f4-48ec-9f2f-8e518ecb6eec",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/2",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/2",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/2",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-08885e73-2abb-4866-bb49-4d876822fa05",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/3",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/3",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/3",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/4",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/4",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/4",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "retained-earlier-or-final-cutoff-work-and-authority-evidence",
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-0e53c244-5ba3-4d96-b499-4e233e3a8936",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/5",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/5",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/5",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-0f45ebc8-24a7-4e9b-9fee-35a3c72290d0",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/6",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/6",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/6",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-0f674e05-72fb-4dfa-9078-47f7f93ccf8c",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/7",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/7",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/7",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-0fbe2904-7a7b-48d5-b3b7-da81d592f41d",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/8",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/8",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/8",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-1020321d-4f7c-4257-a245-c2461a585b62",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/9",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/9",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/9",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "retained-earlier-or-final-cutoff-work-and-authority-evidence",
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-12c1bd39-1548-483c-b529-2888ce105cee",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/10",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/10",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/10",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-1415d088-0af5-4299-a5df-8dbfc634335b",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/11",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/11",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/11",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "retained-earlier-or-final-cutoff-work-and-authority-evidence",
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-14f4c057-33ba-432c-9207-cc57855abdf8",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/12",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/12",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/12",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-17442b70-89a3-4ea5-82bb-9d0ca2cab71e",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/13",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/13",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/13",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-174cad2e-5b58-42a5-858e-3925c0a45b81",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/14",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/14",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/14",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-18cc8df4-7a58-493c-a584-5975027af3ad",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/15",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/15",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/15",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-1ece32b6-7d83-4bcc-a4de-52bd136d570f",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/16",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/16",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/16",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-210ffd48-6f47-4a3d-85bc-1b3617b9b139",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/17",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/17",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/17",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-298f8b56-c687-404f-99e1-d1c1e53baf0c",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/18",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/18",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/18",
        "governingSevenCaseSource": "audits/parked-agent-resumption-2026-10-09/r13-cold57-held-item-step-applicability-source-424d5.json#/cases/0"
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "preserve-governing-seven-case-review-open",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-2a56400c-0263-46b7-9667-fe2ac22cec80",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/19",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/19",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/19",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-3067d842-6f5a-41ad-bada-9a47df0ea9a6",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/20",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/20",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/20",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "retained-earlier-or-final-cutoff-work-and-authority-evidence",
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-3077f62c-1a5d-4be6-896c-e75866032dcb",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/21",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/21",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/21",
        "governingSevenCaseSource": "audits/parked-agent-resumption-2026-10-09/r13-cold57-held-item-step-applicability-source-424d5.json#/cases/1"
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "preserve-governing-seven-case-review-open",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-312c90f2-a3bd-4c92-ac4e-4eae40ae2647",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/22",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/22",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/22",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "retained-earlier-or-final-cutoff-work-and-authority-evidence",
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-340db785-4864-494c-9d24-d9c3d4ce2f6c",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/23",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/23",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/23",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-353a50d8-bcff-423e-9334-9498ed6ff4e9",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/24",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/24",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/24",
        "governingSevenCaseSource": "audits/parked-agent-resumption-2026-10-09/r13-cold57-held-item-step-applicability-source-424d5.json#/cases/2"
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "preserve-governing-seven-case-review-open",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-35487441-ba34-4a1d-ba7f-839d3585becf",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/25",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/25",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/25",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-35abc0ff-4711-4e19-bcaf-07e6ff0da983",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/26",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/26",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/26",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-3790bff3-9f96-445b-a6f5-bddc36f217bf",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/27",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/28",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/28",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-3e76622f-f481-4032-b89c-8015f2dfa6b5",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/28",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/29",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/29",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-449b83a8-a709-43af-9681-768dc6ac744a",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/29",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/30",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/30",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "retained-earlier-or-final-cutoff-work-and-authority-evidence",
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-449d831c-b3e3-4fad-8816-cc35d56c30cc",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/30",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/31",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/31",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-4a152da3-3ef7-420f-a82b-bfab10cf563a",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/31",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/32",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/32",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-4e1fbeb0-d056-4e46-b5a6-27d2a6e9df58",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/32",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/34",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/34",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-4f6ea469-1018-4149-ad55-3fb2883e404a",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/33",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/35",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/35",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-517bc2b4-a5c0-447b-96a2-bc3f1940ceca",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/34",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/36",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/36",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-533a9a79-33ef-487f-876c-41ac39337175",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/35",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/37",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/37",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-54c73bd5-e418-4a16-ba65-0a825b32ed50",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/36",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/38",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/38",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-59826d83-3b3c-4029-b504-536ae91f45dc",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/37",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/39",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/39",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-61f9729d-fef8-416a-88a8-72293cce5695",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/38",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/41",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/41",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-625df130-d2ce-4aef-badb-9e68b6ee51d4",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/39",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/42",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/42",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-63bb4991-a409-47dc-afd4-b4616d64c73d",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/40",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/43",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/43",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-684c584a-3351-49ee-a145-f657d7e42237",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/41",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/44",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/44",
        "governingSevenCaseSource": "audits/parked-agent-resumption-2026-10-09/r13-cold57-held-item-step-applicability-source-424d5.json#/cases/3"
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "preserve-governing-seven-case-review-open",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-69e1022f-5619-4c52-aead-87d926c1b432",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/42",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/45",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/45",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-6b620d7a-a070-4ecc-a63c-1c81ffc321af",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/43",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/46",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/46",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-6e3cb6d4-4014-41ae-81ce-6305bc7d6a41",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/44",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/47",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/47",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-6e8d0b9f-cdc3-4c53-806f-d187a0016e5e",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/45",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/48",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/48",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-704f5a66-5e60-4adf-8044-c45a75cfd9d8",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/46",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/49",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/49",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-70fcd6a0-d71e-469e-af2c-3f9faa51679b",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/47",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/50",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/50",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-72f78fbb-7e47-41ae-a842-35c83b8fcdd2",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/48",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/51",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/51",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-7449fcf0-768a-43a5-8d3f-5ab55604ac4c",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/49",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/52",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/52",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/50",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/53",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/53",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "retained-earlier-or-final-cutoff-work-and-authority-evidence",
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-7ac2753d-7d1d-4fd5-9a4a-e115e91d6aaf",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/51",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/54",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/54",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-7ec704fa-dc6a-4965-bb37-13576272127a",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/52",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/55",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/55",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-80a51f05-4c07-4259-a883-8b9ef4b2a7ca",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/53",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/56",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/56",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-812af642-19bb-41ea-ba19-e20458d5759f",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/54",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/57",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/57",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-82c46308-5eb9-4237-9d2d-950d322576c4",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/55",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/58",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/58",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "retained-earlier-or-final-cutoff-work-and-authority-evidence",
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-86cd7f0e-8929-469b-af96-e7ff9ead8e01",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/56",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/59",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/59",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-8d2cb6cc-8f27-4a25-8541-b00927471b94",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/57",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/60",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/60",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "retained-earlier-or-final-cutoff-work-and-authority-evidence",
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-928e075d-6320-4ecf-9149-8c86187a9ed8",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/58",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/61",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/61",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-960a52e7-9b11-42ac-8fe9-7e5e7e0da441",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/59",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/62",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/62",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "retained-earlier-or-final-cutoff-work-and-authority-evidence",
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-9844199a-9ccd-4c7b-a47c-03bea510ee31",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/60",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/63",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/63",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-990b747e-c51f-482f-bf3d-8ffaa2b9ec34",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/61",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/64",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/64",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-9b0d7528-da21-48ce-92a6-c98ca8c4777e",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/62",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/65",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/65",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-9d2295e7-3ce3-4776-a70e-21d3adb8b0a5",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/63",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/66",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/66",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-a0207b03-ccc8-43e2-8830-e47a09f36573",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/64",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/67",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/67",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-a1cfa7fb-6d21-4bf0-b4aa-7482a73212a7",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/65",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/68",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/68",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-a8d3f4c4-6268-47bb-9b42-c2a653e75e9f",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/66",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/69",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/69",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-a969f93a-6e0b-4c86-a1c0-a5cf3283af8f",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/67",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/70",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/70",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-ab8cc07f-e903-4467-ac45-a32149258170",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/68",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/72",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/72",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "retained-earlier-or-final-cutoff-work-and-authority-evidence",
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/69",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/73",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/73",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "retained-earlier-or-final-cutoff-work-and-authority-evidence",
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-ad69d345-2a2e-44dc-91e1-82214609ff1a",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/70",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/74",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/74",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-af19b8e7-8887-4ddf-9de9-705fd2a19071",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/71",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/75",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/75",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-b24bba70-8532-4c3f-8894-8a098a016b31",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/72",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/76",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/76",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-b4028e2d-590a-4d1c-9256-b44536574813",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/73",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/77",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/77",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-b7ae044b-c702-4275-8857-d8c0943bc6f6",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/74",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/78",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/78",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "retained-earlier-or-final-cutoff-work-and-authority-evidence",
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-b83c1f62-d5f3-49a7-b59d-e38fa0ecf97d",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/75",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/79",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/79",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-b90c2f86-5497-4fa0-ad9a-387132dc9730",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/76",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/80",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/80",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-b9ccbf0d-131b-4a64-aca3-90987d99d842",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/77",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/81",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/81",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-ba80f2f7-46f6-4aec-b99a-21e02460933f",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/78",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/82",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/82",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "retained-earlier-or-final-cutoff-work-and-authority-evidence",
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-bce4e498-fbb7-4457-acc3-1ae2215875e0",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/79",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/83",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/83",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-bf22e2b4-9980-4a5b-9ec8-1ee8a4438e97",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/80",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/84",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/84",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-c029e8fc-24ed-4ad8-8994-a003d2be60f6",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/81",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/85",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/85",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "retained-earlier-or-final-cutoff-work-and-authority-evidence",
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-c832d9a7-6920-4550-9674-9cf05dcc513a",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/82",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/87",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/87",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-cc7811cb-e5a2-4fba-aa88-82b8b0af286b",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/83",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/88",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/88",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-cca022c6-abd0-481c-bac8-5b2515247196",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/84",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/89",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/89",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-cf144a16-16f8-4e0b-9385-34a3c60a4c36",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/85",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/90",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/90",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-d04734a3-55b6-4397-aa78-f94023423da4",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/86",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/91",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/91",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-d3f260f3-10dd-410f-a483-64a8aa6d94f2",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/87",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/92",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/92",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-d589b5a0-2b4e-4413-a74a-430577e14cd5",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/88",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/93",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/93",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-d759f7bc-0b18-43bd-8945-b839fa0e54c9",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/89",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/94",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/94",
        "governingSevenCaseSource": "audits/parked-agent-resumption-2026-10-09/r13-cold57-held-item-step-applicability-source-424d5.json#/cases/4"
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "preserve-governing-seven-case-review-open",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-d88420f0-c0b4-4dc7-92c7-f60ab3ddab44",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/90",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/95",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/95",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "retained-earlier-or-final-cutoff-work-and-authority-evidence",
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-ddac0f5b-1a6b-43fc-b881-754ab28175ee",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/91",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/96",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/96",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-ddb4cbf4-2581-4f7c-8d6a-efbb712bd295",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/92",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/97",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/97",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "retained-earlier-or-final-cutoff-work-and-authority-evidence",
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-e29e77de-45ec-4677-b1b4-3b662ab57a95",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/93",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/99",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/99",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-e2f4c8b8-3d4a-4f05-9607-d7de17e558f4",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/94",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/100",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/100",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-e72eb90d-23bb-4363-aaf7-72e4c693c881",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/95",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/101",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/101",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-ec24b79e-fb5f-4056-847e-c1bd3edfec3a",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/96",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/102",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/102",
        "governingSevenCaseSource": "audits/parked-agent-resumption-2026-10-09/r13-cold57-held-item-step-applicability-source-424d5.json#/cases/5"
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "preserve-governing-seven-case-review-open",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/97",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/103",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/103",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "retained-earlier-or-final-cutoff-work-and-authority-evidence",
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-f5fc3980-cd07-43d9-8931-d48d75988a29",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/98",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/104",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/104",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-f6b6fcca-f4f9-484f-86ca-974378824a67",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/99",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/105",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/105",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-f6e9cbee-faee-465e-9281-2743f85a91ab",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/100",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/106",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/106",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "retained-earlier-or-final-cutoff-work-and-authority-evidence",
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-f943ed28-5fdf-4bb5-a258-7d7f814319d3",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/101",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/107",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/107",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-f9c6b250-0e9a-4fa8-85d3-0d6edf183297",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/102",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/108",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/108",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-faf26552-0633-4081-a250-172c02f07c19",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/103",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/109",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/109",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/104",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/110",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/110",
        "governingSevenCaseSource": "audits/parked-agent-resumption-2026-10-09/r13-cold57-held-item-step-applicability-source-424d5.json#/cases/6"
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "preserve-governing-seven-case-review-open",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-ffb42793-4137-46e2-8f7e-5b78c92ed607",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/105",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/111",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/111",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "retained-earlier-or-final-cutoff-work-and-authority-evidence",
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-respawn-03e7b214f48eef2846ff673f14bfc298",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/106",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/112",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/112",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-respawn-302388a21ed7ab77379045848faa0690",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/107",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/113",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/113",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-respawn-d4be19ee8a5d30542446e0190ae6afe4",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/108",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/114",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/114",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    },
    {
      "ownerId": "su-respawn-f5b5aaaedcd83439ae8e1d33621374ae",
      "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-independent110-pre-outcome-source-review-20261014-424d5.json#/rows/109",
      "sourceRefs": {
        "route": "audits/parked-agent-resumption-2026-10-09/r13-original116-route-custody-cold8-v5-424d5.json#/rows/115",
        "cutoffControlReview": "audits/parked-agent-resumption-2026-10-09/r13-original116-cutoff-control-carry-review-fire30-v2-424d5.json#/rows/115",
        "governingSevenCaseSource": null
      },
      "eligibilityReview": {
        "status": "review-open",
        "historicalReviewApplicability": "not-established-at-final-cutoff",
        "currentControlCase": "no-seven-case-join; no-absence-claim",
        "eligibilityAccepted": false,
        "missingPredicates": [
          "complete-final-cutoff-held-work-and-control-applicability",
          "cutoff-continuity",
          "explicit-pre-outcome-disposition"
        ]
      }
    }
  ],
  "limits": [
    "Cardinality differences concern retained snapshots; they do not prove an unidentified fourth held item existed at the same instant.",
    "A named held set does not establish cutoff actionability, control applicability, runtime credential or guaranteed next wake.",
    "Earlier justified labels and later releases do not settle eligibility or continuity.",
    "Mutable #checkpoint locators retain their saved original text; current substitution is prohibited."
  ],
  "summary": {
    "independentRows": 110,
    "uniqueIndependentRows": 110,
    "fiveWaitRows": 5,
    "sevenControlCases": 7,
    "caseWaitOwnerOverlap": [],
    "cardinalityDifferenceOwners": [
      "su-298f8b56-c687-404f-99e1-d1c1e53baf0c",
      "su-fc5749a7-6632-4f73-9c99-8b475641e7e2"
    ],
    "eligibilityAccepted": 0,
    "continuityAccepted": 0,
    "outcomesJoined": 0,
    "originalReceiptPopulation": 137,
    "acceptedReceipts": 113,
    "unresolvedReceipts": 24
  },
  "next": "Use each governingCases[].heldSourcePath and controlSource/withdrawalSource to resolve original dated controls plus complete held-source custody. Prioritize the two snapshot-cardinality differences, then eleven unknown next actions for su-3077f62c. Preserve typed custody gates and original018 exact admission/await guarantees; freeze eligibility and continuity before outcomes."
}
