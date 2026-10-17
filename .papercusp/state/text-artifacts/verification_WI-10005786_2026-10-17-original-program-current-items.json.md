---
rel_path: "verification/WI-10005786/2026-10-17-original-program-current-items.json"
updated_at: 1792259406303
_body: "content"
---

{
  "measuredAt": "2026-10-17T17:50:06.283Z",
  "scope": "original thirteen nonterminal delivery candidates plus current performance, shipment rollup, and native plan",
  "plans": [
    {
      "slug": "blender-evidence-driven-learning-redesign-2026-09-04",
      "ok": true,
      "status": "ready",
      "archived": false,
      "version": 38,
      "contentHash": "34ebea9bbb21c5b224429ce39e7b76370d869a73fc05f0278f6441a1de8d8018",
      "counts": {
        "items": 12,
        "decisions": 8,
        "sections": 9
      },
      "items": [
        {
          "plan": "blender-evidence-driven-learning-redesign-2026-09-04",
          "archived": false,
          "item": {
            "id": "P-001",
            "text": "Define the single learning contract for candidates, experiments, evidence, decisions, activation, rollback, actor attribution, pot scope, and delayed outcomes. Reuse the existing experiment/types.ts, experiment/run-core.ts, learning-governor, change-ledger, and work-item provenance seams. `` — note: ← WI-2144596 completed (done)",
            "storedStatus": "done",
            "importance": "urgent",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 1 — Make evidence and authority trustworthy",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-2144596",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-2144596",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "blender-evidence-driven-learning-redesign-2026-09-04",
          "archived": false,
          "item": {
            "id": "P-002",
            "text": "Replace competing Gym acceptance paths with one immutable candidate-version verdict. Carry the complete variant, parent version, evaluator/rubric/code/task hashes, all gate results, and current-parent compare into atomic promotion. Remove positive-dev-anchor-only auto-accept. `` `` — note: ← WI-2144597 completed (done)",
            "storedStatus": "done",
            "importance": "urgent",
            "blockedBy": [
              "P-001"
            ],
            "decisionRefs": [],
            "phase": "Phase 1 — Make evidence and authority trustworthy",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-2144597",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-2144597",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "blender-evidence-driven-learning-redesign-2026-09-04",
          "archived": false,
          "item": {
            "id": "P-003",
            "text": "Make deterministic evaluator evidence typed as pass, fail, or not-measured with task coverage and artifact references; wire the default real adapter's regression and probe signals; make missing required evidence inconclusive. `` `` — note: ← WI-2144598 completed (done)",
            "storedStatus": "done",
            "importance": "urgent",
            "blockedBy": [
              "P-001"
            ],
            "decisionRefs": [],
            "phase": "Phase 1 — Make evidence and authority trustworthy",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-2144598",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-2144598",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "blender-evidence-driven-learning-redesign-2026-09-04",
          "archived": false,
          "item": {
            "id": "P-006",
            "text": "Specify the reviewer matrix. Individual Scout ideas: `blender:grade-idea` derives attribution as owner for an unidentifiable human surface, a resolved SU ownerId for an identified agent, and auto-grader for Mug context; preserve the D-012 no-self-grade guard and verify it in the deployed path. Standard Blender release scorecards: require a named non-author, non-implementer steward or judge to review criterion evidence; the grading-integrity auditor may check evidence completeness but does not replace substantive criterion review. Plan acceptance cards: retain the existing relevance-selected cascade of up to two independent graders, excluding plan participants, rubric author, and shipper. Record reviewer identity, role, selection route, rubric revision, and whether the review is substantive or an integrity audit. `` `` — note: ← WI-2144601 completed (done)",
            "storedStatus": "done",
            "importance": "urgent",
            "blockedBy": [
              "P-001"
            ],
            "decisionRefs": [],
            "phase": "Phase 2 — Make grading independent and useful",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-2144601",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-2144601",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "blender-evidence-driven-learning-redesign-2026-09-04",
          "archived": false,
          "item": {
            "id": "P-012",
            "text": "Re-run the Blender release rubric and both provenance-isolated drills against a current generation after the owner lifts the pause; require complete scorecards, independent criterion review, freshness, and a reproducible rollback before public release. `` `` — note: D-008: later owner directive1111 lifts blanket papercusp learning pause while preserving IQ-battery/improvement-implement exceptions. Final acceptance blocked by owned producer-integration gap EI-24932377195872399 plus unproven generation parity/fresh rubric+drill evidence; not shipped.",
            "storedStatus": "todo",
            "importance": "urgent",
            "blockedBy": [
              "P-011"
            ],
            "decisionRefs": [],
            "phase": "Phase 3 — Prove learning before choosing an optimizer",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "todo",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "unclaimed",
            "links": [
              {
                "id": "WI-2144607",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": false
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "EI-24932377195872399",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "blender-evidence-driven-learning-redesign-2026-09-04",
          "archived": false,
          "item": {
            "id": "P-004",
            "text": "Correct release statistics: compute an actual confidence bound for nonzero errors, separate improvement over the historical baseline from the literal release bar, and add nonzero-error and repeated-peeking tests. `` `` — note: ← WI-2144599 completed (done)",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [
              "P-001"
            ],
            "decisionRefs": [],
            "phase": "Phase 1 — Make evidence and authority trustworthy",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-2144599",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-2144599",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "blender-evidence-driven-learning-redesign-2026-09-04",
          "archived": false,
          "item": {
            "id": "P-005",
            "text": "Close every learning spend attempt through governor reservation and settlement, including proposer calls, partial evaluations, cancellation, and failures; expose requested, reserved, used, and unsettled spend separately. `` `` — note: ← WI-2144600 completed (done)",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [
              "P-001"
            ],
            "decisionRefs": [],
            "phase": "Phase 1 — Make evidence and authority trustworthy",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-2144600",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-2144600",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "blender-evidence-driven-learning-redesign-2026-09-04",
          "archived": false,
          "item": {
            "id": "P-007",
            "text": "Separate reviewer preference, artifact delivery, measured effectiveness, regressions, cost, and uncertainty in Scout rewards. Grades may guide prioritization while outcomes mature; matured outcomes must determine effectiveness. Keep pending and right-censored outcomes visible and prevent one fused artifact from receiving independent success credit for every source idea. `` `` — note: ← WI-2144602 completed (done)",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [
              "P-006"
            ],
            "decisionRefs": [],
            "phase": "Phase 2 — Make grading independent and useful",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-2144602",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-2144602",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "blender-evidence-driven-learning-redesign-2026-09-04",
          "archived": false,
          "item": {
            "id": "P-008",
            "text": "Resolve pot versus workspace learning ownership. Default observations, policy updates, lens weights, and feedback to the owning pot; expose workspace rollups separately; require explicit provenance and applicability for cross-pot transfer. `` `` — note: ← WI-2144603 completed (done)",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [
              "P-001"
            ],
            "decisionRefs": [],
            "phase": "Phase 2 — Make grading independent and useful",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-2144603",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-2144603",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "blender-evidence-driven-learning-redesign-2026-09-04",
          "archived": false,
          "item": {
            "id": "P-009",
            "text": "Build a reproducible baseline/challenger battery with development, sealed acceptance holdout, and fresh monitoring tasks. Pin task, model, prompt, rubric, code, evaluator, exposure, randomization, repeat, and cost receipts. `` `` — note: ← WI-2144604 completed (done)",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [
              "P-002",
              "P-003",
              "P-004",
              "P-005",
              "P-007",
              "P-008"
            ],
            "decisionRefs": [],
            "phase": "Phase 3 — Prove learning before choosing an optimizer",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-2144604",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-2144604",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "blender-evidence-driven-learning-redesign-2026-09-04",
          "archived": false,
          "item": {
            "id": "P-011",
            "text": "Migrate Scout, Gym, calibration, transfer, regret, and Red Queen outputs into the common candidate/evidence/decision lifecycle; retire alternate promotion and reward writers only after parity evidence exists. `` `` — note: ← WI-2144606 completed (done)",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [
              "P-002",
              "P-006",
              "P-007",
              "P-009",
              "P-010"
            ],
            "decisionRefs": [],
            "phase": "Phase 3 — Prove learning before choosing an optimizer",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-2144606",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-2144606",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "blender-evidence-driven-learning-redesign-2026-09-04",
          "archived": false,
          "item": {
            "id": "P-010",
            "text": "Compare the current Gym optimizer, a simple trace-reflection baseline, and GEPA under matched task splits, models, exposure, and total spend; select based on measured quality, regression, uncertainty, and cost. `` `` — note: ← WI-2144605 completed (done)",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [
              "P-009"
            ],
            "decisionRefs": [],
            "phase": "Phase 3 — Prove learning before choosing an optimizer",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-2144605",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-2144605",
              "state": "done",
              "terminal": true
            }
          ]
        }
      ]
    },
    {
      "slug": "blender-public-release-readiness-drive-2026-07-14",
      "ok": true,
      "status": "awaiting-acceptance",
      "archived": true,
      "version": 23,
      "contentHash": "6032f586014722b3812ee317a4408060702a4c170060f8bc682502508badf839",
      "counts": {
        "items": 8,
        "decisions": 1,
        "sections": 5
      },
      "items": [
        {
          "plan": "blender-public-release-readiness-drive-2026-07-14",
          "archived": true,
          "item": {
            "id": "P-001",
            "text": "Root-cause the cycle-error-rate FAIL and confirm the fix class is deployed — findings in Background; remains: verify zero NEW error ticks post-17:31-deploy and that capacity waits surface as gated/no-capacity, not errors (← WI-4812 completed resolved)",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 1 — prove the deployed pin",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-4811",
                "rel": "relates",
                "activity": "free",
                "terminal": true
              },
              {
                "id": "WI-4812",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-4812",
              "state": "resolved",
              "terminal": true
            }
          ]
        },
        {
          "plan": "blender-public-release-readiness-drive-2026-07-14",
          "archived": true,
          "item": {
            "id": "P-002",
            "text": "Fresh origin='drill' e2e proof on the deployed public composition (blender:run-drill) — clears e2e-drill at-risk from EI-11879 (← WI-4813 completed resolved)",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 1 — prove the deployed pin",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-4813",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "EI-11879",
              "state": "done",
              "terminal": true
            },
            {
              "ref": "WI-4813",
              "state": "resolved",
              "terminal": true
            }
          ]
        },
        {
          "plan": "blender-public-release-readiness-drive-2026-07-14",
          "archived": true,
          "item": {
            "id": "P-003",
            "text": "Instrument-integrity re-read on the exact deployed pin: ratified keys bound (grader-feedback-revised confirmed live), bars discriminate — clear the standing at-risk (← WI-4814 completed resolved)",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 1 — prove the deployed pin",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-4814",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-4814",
              "state": "resolved",
              "terminal": true
            }
          ]
        },
        {
          "plan": "blender-public-release-readiness-drive-2026-07-14",
          "archived": true,
          "item": {
            "id": "P-004",
            "text": "GRADE pass: grade a batch of ungraded routed ideas (blender:grade-idea) with typed feedback — deepen grading-loop-closure margin (currently 2 graded / 261 routed) and teach lens weights (← WI-4815 completed resolved)",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 1 — prove the deployed pin",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-4815",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-4815",
              "state": "resolved",
              "terminal": true
            }
          ]
        },
        {
          "plan": "blender-public-release-readiness-drive-2026-07-14",
          "archived": true,
          "item": {
            "id": "P-005",
            "text": "File a fresh blender-release-readiness scorecard with deployed-pin evidence (improvements:capture rubricRef+ratings)  (← WI-4816 completed resolved)",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [
              "P-002"
            ],
            "decisionRefs": [],
            "phase": "Phase 2 — re-grade and hold the bar",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-4816",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-4816",
              "state": "resolved",
              "terminal": true
            }
          ]
        },
        {
          "plan": "blender-public-release-readiness-drive-2026-07-14",
          "archived": true,
          "item": {
            "id": "P-006",
            "text": "Drive cycle-error-rate below 5% in the live window and blender:success-metrics verdict=pass — projected mechanical recovery ~07-15 midday absent new errors; any NEW post-fix error tick is a fresh defect to fix, not weather  (← WI-4817 released) (Verified live via DB: scout_ticks origin=scout error rate since 2026-07-16 20:00 EDT = 3.13% 1/32, well under the 5% bar — the sole error 00:05:48 is a known-residual GENERATION-phase transport-timeout class, already documented non-blocking in the plan's own Now text. A transient 'lastIdeation is not defined' ReferenceError burst 5 errors, 19:25-19:51 self-resolved by 19:55 and has not recurred across 4 subsequent bg-host restarts 22:13/22:35/23:22/00:29 + ~40 ticks — current deployed source cycle-deps.ts confirms correct `deps.lastIdeation` property access, no bare-identifier bug remains.)",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [
              "P-001"
            ],
            "decisionRefs": [],
            "phase": "Phase 2 — re-grade and hold the bar",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-4934",
                "rel": "relates",
                "activity": "free",
                "terminal": true
              },
              {
                "id": "WI-4935",
                "rel": "relates",
                "activity": "free",
                "terminal": true
              },
              {
                "id": "WI-4817",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-4817",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "blender-public-release-readiness-drive-2026-07-14",
          "archived": true,
          "item": {
            "id": "P-007",
            "text": "Improve the rubric as it is used [owner:Avi 2026-07-13]: revise criteria that proved ambiguous/weak during grading (plans:set-template-data / rubrics:propose with loss-guards) (← WI-4818 completed resolved)",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 2 — re-grade and hold the bar",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-4818",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-4818",
              "state": "resolved",
              "terminal": true
            }
          ]
        },
        {
          "plan": "blender-public-release-readiness-drive-2026-07-14",
          "archived": true,
          "item": {
            "id": "P-008",
            "text": "GO/NO-GO public-release readiness report to Avi with the full evidence chain  (← WI-4819 released) (GO/NO-GO report delivered to Avi WI-4819 comment + coord:send — verdict GO: both D-001 conditions met blender cycle-error-rate 3.13%/<5% + EI-12108 fix confirmed holding, fresh live E2E production completions.) (← WI-4819 completed resolved)",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [
              "P-005",
              "P-006"
            ],
            "decisionRefs": [
              "D-001"
            ],
            "phase": "Phase 2 — re-grade and hold the bar",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-4819",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-4819",
              "state": "done",
              "terminal": true
            },
            {
              "ref": "EI-12108",
              "state": "resolved",
              "terminal": true
            }
          ]
        }
      ]
    },
    {
      "slug": "blender-self-learning-2026-07-12",
      "ok": true,
      "status": "draft",
      "archived": true,
      "version": 143,
      "contentHash": "9b44a2ea8a8261c91f12e490867fce267922d08f263cac605959f6db3ef8847c",
      "counts": {
        "items": 13,
        "decisions": 0,
        "sections": 9
      },
      "items": [
        {
          "plan": "blender-self-learning-2026-07-12",
          "archived": true,
          "item": {
            "id": "P-001",
            "text": "Signal accumulator + watermark: PG table (migration via next-migration.mjs allocator) tracking per-lane new-signal counts/high-water since last SUCCESSFUL cycle (scorecards w/ rating CHANGES, observations, captures, reverts, deferrals, completions); updated by a zero-token deterministic sweep on the existing 30s routinesTick (watchdog pattern)  (← WI-4317 released) (shipped+verified live su-01ad37b0, handoff 2026-07-12) (← WI-4317 released) (← WI-4317 released) (← WI-4317 open) (← WI-4317 released) (← WI-4317 released) (← WI-4317 completed resolved)",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 1 — Deterministic signal substrate",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-4317",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-4317",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "blender-self-learning-2026-07-12",
          "archived": true,
          "item": {
            "id": "P-002",
            "text": "Volume-based cycle firing: cadence gate consumes the accumulator — weighted new-signal score ≥ threshold fires; score 0 NEVER fires (stale-corpus cycles eliminated); keep friction fast-path (watchdog storms), ideas-drained trigger, min-floor ~10-15min burst coalescing; raise/drop the 3600s max-age heartbeat; budget cap unchanged; ship flag-ON with a kill-switch flag (reversible cutover)  (← WI-4318 released) (shipped+verified live su-01ad37b0, handoff 2026-07-12) (← WI-4318 released) (← WI-4318 released) (← WI-4318 open) (← WI-4318 released) (← WI-4318 released) (← WI-4318 completed resolved)",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 1 — Deterministic signal substrate",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-4318",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-4318",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "blender-self-learning-2026-07-12",
          "archived": true,
          "item": {
            "id": "P-003",
            "text": "Persisted digest snapshot + DELTA-FIRST rendering: build digest once at fire time, persist snapshot row, render prompt leading with \"NEW since your last cycle\" (per-lane deltas from the watermark) before standing top patterns — kills the stale-repetition → dedup-decline churn  (← WI-4319 released) (shipped+verified live su-01ad37b0, handoff 2026-07-12) (← WI-4319 released) (← WI-4319 released) (← WI-4319 open) (← WI-4319 released) (← WI-4319 released) (← WI-4319 completed resolved) (← WI-4319 open) (← WI-4319 released) (← WI-4319 resolved) (← WI-4319 completed resolved) (← WI-4319 completed resolved)",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 1 — Deterministic signal substrate",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-4319",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-4319",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "blender-self-learning-2026-07-12",
          "archived": true,
          "item": {
            "id": "P-004",
            "text": "Deterministic rubric seeding: each cycle, code (not LLM) selects worst-N rubric criterion patterns (severity×recency) and issues one TARGETED ideation call per pattern, returned idea REQUIRED to ground on that rubric: ref (niche-map seededBy mechanism, proven live). Fixes the 0/116-ever rubric grounding  (shipped+verified live su-01ad37b0, handoff 2026-07-12)",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 2 — Scorecards actually generate ideas",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          }
        },
        {
          "plan": "blender-self-learning-2026-07-12",
          "archived": true,
          "item": {
            "id": "P-005",
            "text": "Grader suggestion seeds: optional suggestion field (~2000 chars) on scorecard ratings (improvements:capture observation.ratings) — a SEED, not a routed idea (never enters triage); digest rubricRatings lane carries top-K recent suggestions with scorecard refs; Blender curates via existing critique/recombine gauntlet; adopted suggestions keep refs → grader sees impact in observationsImpact readback. NEVER replaces su direct filing (D-004 fixes-plan)  (shipped+verified live su-01ad37b0, handoff 2026-07-12)",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [],
            "decisionRefs": [
              "D-004"
            ],
            "phase": "Phase 2 — Scorecards actually generate ideas",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          }
        },
        {
          "plan": "blender-self-learning-2026-07-12",
          "archived": true,
          "item": {
            "id": "P-006",
            "text": "Per-lane grounding metric + lane-silence alarm: grounding counts per digest lane recorded on each scout_tick; alarm (watchdog collector or infra-liveness condition) when a populated lane stays ungrounded N cycles — the missing detector that let rubric-blindness sit invisible 3 weeks  (shipped+verified live su-01ad37b0, handoff 2026-07-12)",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 2 — Scorecards actually generate ideas",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          }
        },
        {
          "plan": "blender-self-learning-2026-07-12",
          "archived": true,
          "item": {
            "id": "P-007",
            "text": "watchdog-health lane: aggregate watchdog_ticks (33 collectors × 15min, already persisted) → per-collector 7d fire rate, trend, CHRONICITY (ticks-nonzero streak, e.g. unresolved-escalation steady at 10/tick), MTTR, flap count; plus detector-health meta (blind/erroring/always-zero collectors — perf-regression self-reports blind NOW; ephemeral-filter drop volume; capture-funnel captured/declined/deferred ratios; open-key dwell); refs watchdog:<collector>  (shipped+verified live su-01ad37b0, handoff 2026-07-12)",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 3 — New signal lanes (deterministic readers → MetaPatterns; flattenDigest carries them free)",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          }
        },
        {
          "plan": "blender-self-learning-2026-07-12",
          "archived": true,
          "item": {
            "id": "P-008",
            "text": "coord-health lane: escalation storms, unanswered directed messages, wake storms, claim conflicts from coord_event_log (dev:coordCategorize reader exists) — coordination breakdown is the richest untapped ideation substrate  (← WI-4453 completed resolved)",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 3 — New signal lanes (deterministic readers → MetaPatterns; flattenDigest carries them free)",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-4453",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-4453",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "blender-self-learning-2026-07-12",
          "archived": true,
          "item": {
            "id": "P-012",
            "text": "E2E integration test (cycle-real-rails home): seed rubric-graded observations w/ broken ratings → digest → fake-LLM ideator cites rubric ref → assert routed idea carries rubric: ref + ledger row lands. The end-to-end test the pipeline never had. Unit: accumulator math, gate verdicts, lane mappers, delta rendering. Property tests on 7-lane grounding (w/ fixes-plan P-004)  (shipped+verified live su-01ad37b0, handoff 2026-07-12)",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 4 — Learning-loop closure + verification",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          }
        },
        {
          "plan": "blender-self-learning-2026-07-12",
          "archived": true,
          "item": {
            "id": "P-015",
            "text": "Success metrics gate (program done-check): rubric-grounded routed ideas >0 sustained; zero score-0 cycles fired (spend drops in quiet periods, cycles track activity bursts); cycle error rate <5% (from 30%, w/ fixes-plan P-001); ledger rows reconcile with tick routed counts (w/ fixes-plan P-003); ≥1 grader suggestion adopted + shipped with attribution  (success-metrics gate shipped as blender:success-metrics + run live: 3/5 bars FAIL bugs filed, 1 unknown, 1 pass)",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 4 — Learning-loop closure + verification",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-4459",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          }
        },
        {
          "plan": "blender-self-learning-2026-07-12",
          "archived": true,
          "item": {
            "id": "P-009",
            "text": "tool-telemetry lane: per-tool error rates/p95, limit-failure rates, retry loops from tool_invocations (dev:telemetry reader exists) — measured DX friction vs self-reported (← WI-4454 completed resolved)",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 3 — New signal lanes (deterministic readers → MetaPatterns; flattenDigest carries them free)",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-4454",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-4454",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "blender-self-learning-2026-07-12",
          "archived": true,
          "item": {
            "id": "P-010",
            "text": "gate/pipeline-health lane: red-gate durations, flaky-test verdict flips, promotion stalls (live example: main-behind-staging pages + standing red-test keys = ONE incident no consumer joins today), deploy latency (dev:why substrate) (Resuming gate/pipeline-health lane build WI-4455 — re-claiming lapsed lane.) (gate/pipeline-health lane built+tested+wired+verified WI-4455. Goes live on next bg-host restart deferred to protect WI-4475 baseline.) (← WI-4455 completed resolved) (← WI-4455 completed resolved)",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 3 — New signal lanes (deterministic readers → MetaPatterns; flattenDigest carries them free)",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-4455",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-4455",
              "state": "done",
              "terminal": true
            },
            {
              "ref": "WI-4475",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "blender-self-learning-2026-07-12",
          "archived": true,
          "item": {
            "id": "P-013",
            "text": "Live drill as repeatable health check: file origin:drill scorecard batch w/ distinctive broken criterion (drill rows stay out of organic learners by design) → force one tick → verify rubric-grounded idea routed + per-lane grounding metric increments (← WI-4457 released) (← WI-4457 released) (← WI-4457 completed resolved)",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 4 — Learning-loop closure + verification",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-4457",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-4457",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "blender-self-learning-2026-07-12",
          "archived": true,
          "item": {
            "id": "P-014",
            "text": "Grading throughput verification: ungraded-filings-watchdog firing on fresh code (first 7d deadlines hit ~07-17); grade→revise wakes + lens win-credit + feedback priming verified live once grades flow; success = su-ideate graded fraction rises from 0/104 (backstop accelerated to 2d; verifying nudges fire + graded count rises) (Re-claiming — active grading-throughput watch WI-4458, awaiting first su-ideate-ungraded fires deadline ~07-17.) (← WI-4458 released) (← WI-4458 completed resolved)",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 4 — Learning-loop closure + verification",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-4458",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-4458",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "blender-self-learning-2026-07-12",
          "archived": true,
          "item": {
            "id": "P-011",
            "text": "Backlog lanes (defer until above prove out): spend anomalies (e.g. $66k unattributed bucket), owner-correction signals ([owner:] facts + grade feedback text), knowledge-reuse gaps (unused recipes, docs-search misses), plan health (draft dwell, stale wip)  (← WI-4456 released) (← WI-4456 released) (Verified shipped: curation-signal-lanes.ts implements all 4 backlog lanes spendAnomalies, ownerCorrections, knowledgeReuseGaps, planHealth, wired into cycle-deps.ts→corpus-digest→lenses.ts. 6/6 curation-signal-lanes tests green. Item text itself already noted ← WI-4456 released.)",
            "storedStatus": "done",
            "importance": "low",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 3 — New signal lanes (deterministic readers → MetaPatterns; flattenDigest carries them free)",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-4456",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-4456",
              "state": "done",
              "terminal": true
            }
          ]
        }
      ]
    },
    {
      "slug": "federated-scout-gym-learning-2026-07-02",
      "ok": true,
      "status": "draft",
      "archived": true,
      "version": 65,
      "contentHash": "2aab21f1fb0eda429ac3ec4260e6ea487c5310371bba798b8959029e8ba15873",
      "counts": {
        "items": 16,
        "decisions": 7,
        "sections": 9
      },
      "items": [
        {
          "plan": "federated-scout-gym-learning-2026-07-02",
          "archived": true,
          "item": {
            "id": "P-001",
            "text": "F0-1 Niche-descriptor vocabulary v1 (THE merge prerequisite): small fixed global schema (owner-ratified) for QD niche coordinates so heterogeneous peers describe niches comparably — e.g. dims: target-surface (loop|substrate|ui|infra|process), change-shape (guard|automation|capability|integration), risk, scope-size. Wire format versioned to allow embedding-space niches (option b) later without breaking merge. Decision doc + schema in gym types.",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 0 — foundations",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          }
        },
        {
          "plan": "federated-scout-gym-learning-2026-07-02",
          "archived": true,
          "item": {
            "id": "P-002",
            "text": "F0-2 Federation eligibility rule: only OUTCOME-VERIFIED or grade≥4 elites federate (unverified ideas = spam-by-design on an open network); facts federate hive-scoped by default, cross-network ONLY when explicitly marked shareable (opt-in publish). Encode as policy defaults, owner-overridable via hive_policy.",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 0 — foundations",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          }
        },
        {
          "plan": "federated-scout-gym-learning-2026-07-02",
          "archived": true,
          "item": {
            "id": "P-003",
            "text": "F1-1 New federated op types on the peer-log substrate: `fact` (shareable agent_facts rows) and `elite` (QD elite: niche descriptor v1, fitness, outcome record, source_hive, author_pubkey). Announce/admission/epoch crypto UNCHANGED — these ride the existing typed-op path like content ops. Receiver-side pinning like L9 (hive/harness receiver-pins, not sender-trust).",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 1 — substrate ops (hive-scoped first)",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-1694",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          }
        },
        {
          "plan": "federated-scout-gym-learning-2026-07-02",
          "archived": true,
          "item": {
            "id": "P-004",
            "text": "F1-2 gym_qd_archive provenance + merge rule: source_hive + author_pubkey columns (patterns from work_items), merge = keep max-fitness per niche with foreign-tagged provenance; a foreign elite landing in a locally-EMPTY niche is flagged as a novelty-gift (metric input). Idempotent re-merge (HLC/fed_ts like work_items).",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 1 — substrate ops (hive-scoped first)",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-1695",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          }
        },
        {
          "plan": "federated-scout-gym-learning-2026-07-02",
          "archived": true,
          "item": {
            "id": "P-012",
            "text": "F1-4 (review H1/H7): blocked-by WI-1585 attestation fix; refused-op counters per source (first-class observability); thread the WI-1564 workspace resolver in the elite/fact writers + regression test (write/capture/drain agree).  (su-79eda: per-source refused-op counters mig 474 + federation-refused-op-counter.ts + onRefusedOp hook wired in agent-facts + gym-qd-elites projections + elite-writer WI-1564 guard seam markEliteFederatable, mirrors assertFact. 44 unit tests + real-PG upsert verified + typecheck green. Live cross-machine federation e2e deferred on WI-1585 + substrate-sidecar out of lane.)",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 1 — substrate ops (hive-scoped first)",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-1725",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-1585",
              "state": "open",
              "terminal": false
            },
            {
              "ref": "WI-1564",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "federated-scout-gym-learning-2026-07-02",
          "archived": true,
          "item": {
            "id": "P-013",
            "text": "F1-5 (review H2/H6): provenance-partitioned archive (best-per-source-per-niche, read-time max in map lane, revocation cleanup on revoked_pubkeys) + source-partitioned fact keys (facts/SOURCE/scope/ref/key). Supersedes the D-003 keep-higher merge.",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [],
            "decisionRefs": [
              "D-003"
            ],
            "phase": "Phase 1 — substrate ops (hive-scoped first)",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-1696",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          }
        },
        {
          "plan": "federated-scout-gym-learning-2026-07-02",
          "archived": true,
          "item": {
            "id": "P-014",
            "text": "F1-6 (review H3): device-signed outcome records (P-044 verdict shape) for eligibility; reputation weighting from tier 1; per-source AND per-source-per-niche rate caps IN PHASE 1.  (F1-6 device-signed outcome records + per-source-per-niche rate cap. Signing wired sendmarkEliteFederatable+CDC+receiveregister-all resolveSignerDevice+capEliteNicheRateLimiter; mig 478 live; ~111 tests, tsc gate green. Publish-invocation gym-loop→markEliteFederatable tracked separately as an F1-4/P-012 follow-up.)",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 1 — substrate ops (hive-scoped first)",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-1763",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          }
        },
        {
          "plan": "federated-scout-gym-learning-2026-07-02",
          "archived": true,
          "item": {
            "id": "P-015",
            "text": "F2-4 (review H4/H5): HRW rendezvous partition of the empty-niche frontier (disjoint targets per hive); egress secrets-guard redaction + ingress prompt hardening (quote/cap/strip) at the priming boundary.  (su-6b4d2: Lane C. Verifying existing sanitize/frontier seam + wiring the dangling egress redaction.) (su-6b4d2 Lane C: ingress sanitizeForeignPriming wired, tested + HRW empty-frontier partition incl. computeHiveEmptyFrontier seam tested DONE. Egress secrets-guard: NEW sync/hyperbee/content-op-egress-guard.ts wired fail-soft into outbox-drain before epoch-encrypt unit-tested. Egress ACTIVATION blocked-on P-012 drain sends fact/elite ops as issue-shaped garbage — flagged P0 to leader su-cd47dc54 w/ repro+fix. Removed dead scout redactSecretsForForeignPublish.) (su-6b4d2 Lane C DONE. Ingress: sanitizeForeignPriming scout/foreign-priming-sanitize.ts wired in scout-archive-port. Frontier: HRW empty-niche partition + computeHiveEmptyFrontier seam scout/foreign-frontier.ts for P-006. Egress: NEW sync/hyperbee/content-op-egress-guard.ts reuses scanTextForSecrets wired FAIL-SOFT into outbox-drain before epoch-encrypt; redacts fact body / elite rationale, keeps local row intact. Removed dead scout redactSecretsForForeignPublish. Tests: 14 unit egress guard incl. redacted-row-still-passes-isAgentFactWireRow/isGymQdEliteWireRow; frontier e2e; ingress + outbox-drain integration 21/21 green; my 4 files tsc-clean. Egress ACTIVATES once P-012 drain-converter emits real wire values leader cd47d owns, confirmed — guard already verified against that exact wire shape.)",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 1 — substrate ops (hive-scoped first)",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-1758",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          }
        },
        {
          "plan": "federated-scout-gym-learning-2026-07-02",
          "archived": true,
          "item": {
            "id": "P-006",
            "text": "F2-1 Federated-map lane in the corpus digest (same pattern as the standing-fact lane, 2026-07-02): niche-crowding summary (network-wide occupied vs empty niches from the merged archive) + top-3 nearby foreign elites (by descriptor proximity) as recombination seeds. Bounded; fail-soft.  (Lane B claimed by su-2dded — prior bee holder s-178305 died + lease lapsed; taking real Lane-B plan work P-006 federated-map lane, D-004) (Lane B ALREADY IMPLEMENTED + wired + tested-green orphaned fleet:spawn zombies + sibling gym-unwedge-scout-novelty NOV-1. Verified by su-2dded, not rebuilt rule #1. P-006: buildFederatedMapLane crowded/empty, niche:v1 refs over readFederatedArchive gym_qd_archive∪gym_qd_foreign_elites union → digest.nicheMap → flattenDigest niche-map lane. P-007: buildNicheMapPriming 'AVOID crowded/TARGET empty' → ideators → lenses '## Federated niche guidance', gated by owner-steering federatedPriming, foreign text via sanitizeForeignPriming. P-008: buildFederatedSeedPriming analogical recombine + seededByRefs → seededBy: tags on scout_routed_ideas. Tests GREEN: corpus-digest buildFederatedMapLane + 70 Lane-B tests federated-priming/ideator-priming/recombine/cycle/config/novelty-metrics.) (su-6b4d2 picking up P-006 Lane B — my Lane C/P-015 done; P-006's federated-map lane consumes my computeHiveEmptyFrontier seam. 2dded pivoted to WI-1724. Will back off if 2dded/leader redirect.) (su-6b4d2: REVERT — P-006 was already done I flipped it wip on a stale read; my error. Restored to done. Apologies for the churn.)",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [],
            "decisionRefs": [
              "D-004"
            ],
            "phase": "Phase 2 — generation-time integration (the novelty engine)",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-1755",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-1724",
              "state": "resolved",
              "terminal": true
            }
          ]
        },
        {
          "plan": "federated-scout-gym-learning-2026-07-02",
          "archived": true,
          "item": {
            "id": "P-007",
            "text": "F2-2 REPULSION in ideator priming: generation prompt names the globally-CROWDED niches (avoid — already well-explored by N peers) and the EMPTY niches (propose here) — the distributed-novelty-search mechanic that makes more-peers→more-novelty structural. Extend ideator-priming/ideator-feedback-priming seams (do not fork).  (Lane B ALREADY IMPLEMENTED + wired + tested-green orphaned fleet:spawn zombies + sibling gym-unwedge-scout-novelty NOV-1. Verified by su-2dded, not rebuilt rule #1. P-006: buildFederatedMapLane crowded/empty, niche:v1 refs over readFederatedArchive gym_qd_archive∪gym_qd_foreign_elites union → digest.nicheMap → flattenDigest niche-map lane. P-007: buildNicheMapPriming 'AVOID crowded/TARGET empty' → ideators → lenses '## Federated niche guidance', gated by owner-steering federatedPriming, foreign text via sanitizeForeignPriming. P-008: buildFederatedSeedPriming analogical recombine + seededByRefs → seededBy: tags on scout_routed_ideas. Tests GREEN: corpus-digest buildFederatedMapLane + 70 Lane-B tests federated-priming/ideator-priming/recombine/cycle/config/novelty-metrics.)",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 2 — generation-time integration (the novelty engine)",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-1756",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          }
        },
        {
          "plan": "federated-scout-gym-learning-2026-07-02",
          "archived": true,
          "item": {
            "id": "P-009",
            "text": "F3-1 Outcome-weighted reputation: a foreign artifact's priming weight = f(verified outcome record, source hive_policy trust tier). Anti-poisoning: unverified sources decay to zero weight; per-source rate caps. Reuse trust:* + hive_policy tiers — no new trust system.  (Code was complete+tested but the status flip was skipped off-by-one, flagged by peer. NEW scout/federation-reputation.ts: federationReputationWeight = winRate × tierWeight; FEDERATION_TIER_WEIGHT unverified=0 HARD ZERO — anti-poisoning guard 1; no-verified-decided ⇒ weight 0 / winRate null; per-source rate caps sourceRateRemaining/sourceRateCapExceeded, DEFAULT_PER_SOURCE_RATE_CAP — guard 2. Laplace-smoothed win-rate, winCredit-consistent. Designed against P-044 verdict shape; verifiedWins/verifiedDecided populate from Lane A P-014 device-signed outcomes when they land. Tests: federation-reputation.test.ts 9 pass + part of the 99-test combined federated-scout green run; tsc-clean; lint:tsc gate green @224.)",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 3 — trust + rollout + metrics",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-1761",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          }
        },
        {
          "plan": "federated-scout-gym-learning-2026-07-02",
          "archived": true,
          "item": {
            "id": "P-011",
            "text": "F3-3 SUCCESS METRIC (the owner's goal, measurable): novelty-gain-per-peer — (a) unique niches occupied network-wide over time (should grow superlinearly vs isolated baseline), (b) per-node idea-dedup rate vs peer count (should FALL as peers join), (c) foreign-seeded ideas' outcome win-rate vs local-only. Wire into scorecards/quality-metrics before rollout tier 2 so the thesis is tested, not assumed.  (NEW scout/novelty-metrics.ts pure computeNoveltyGainReport + assembly buildNoveltyGainReport over listFrontierElites+readRoutedIdeas + mapProvenanceToNoveltyRow + .test.ts 12 pass, tsc-clean. a uniqueNiches/foreignAddedNiches/nichesPerPeer LIVE from gym_qd_archive∪foreign_elites; b dedupRate scaffolded null until idea novelty-score threaded; c foreignSeededWinRate vs localOnly scaffolded on Lane-B P-008 seededBy read defensively → auto-lights when B lands, winCredit-consistent fractional wins; isControlArm from P-016 isControlHivePriming = falsifiability baseline. No live scorecard consumer exists yet computeScoutQualityReport also unconsumed; scorecard is a draft plan so built scorecard-ready per brief's scaffold-now bar.)",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 3 — trust + rollout + metrics",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-1760",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          }
        },
        {
          "plan": "federated-scout-gym-learning-2026-07-02",
          "archived": true,
          "item": {
            "id": "P-005",
            "text": "F1-3 Negative-results federation: deprecate-with-learnings salvage observations become shareable `fact`-ops (kind: negative-result) so the network stops re-trying dead ends — cheapest highest-leverage artifact. (negative-result facts ride the F1-1 rail; includes the P0 assertFact arbiter fix + harness_slug federation stamp see D-007) (← WI-1699 completed)",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [],
            "decisionRefs": [
              "D-007"
            ],
            "phase": "Phase 1 — substrate ops (hive-scoped first)",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-1699",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-1699",
              "state": "resolved",
              "terminal": true
            }
          ]
        },
        {
          "plan": "federated-scout-gym-learning-2026-07-02",
          "archived": true,
          "item": {
            "id": "P-016",
            "text": "F0-3 (review smaller): depth-aware crowding metric (N above fitness bar); v1→v2 niche-key mapping fn designed WITH v1; control hive at migration-rate 0 as the falsifiability baseline for the novelty metric. (Verified-complete already implemented, no gaps. Depth-aware crowding=computeDepthAwareCrowding scout/federated-priming.ts, consumed by corpus-digest map lane; v1→v2 seam=mapV1KeyForward niche-descriptor.ts, default mapKey; control-hive=CONTROL_HIVE_FEDERATED_PRIMING+isControlHivePriming+all-zeros federatedPriming steering owner-steering:federated-priming via set_steering→cycle-deps readFederatedPriming→crowded/empty=0→empty map lane=zero migration. Tests: npx vitest run federated-priming+niche-descriptor+config+corpus-digest = 65 pass. isControlHivePriming detector reserved for P-011 control-arm labeling.)",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 1 — substrate ops (hive-scoped first)",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-1759",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          }
        },
        {
          "plan": "federated-scout-gym-learning-2026-07-02",
          "archived": true,
          "item": {
            "id": "P-008",
            "text": "F2-3 Cross-pollination through recombine.ts: foreign elites as mutation seeds (\"won in a distant context — recombine with local friction\") riding the analogical lens; per-context lens/outcome stats federate as contextual-bandit records (never global averages). (Lane B ALREADY IMPLEMENTED + wired + tested-green orphaned fleet:spawn zombies + sibling gym-unwedge-scout-novelty NOV-1. Verified by su-2dded, not rebuilt rule #1. P-006: buildFederatedMapLane crowded/empty, niche:v1 refs over readFederatedArchive gym_qd_archive∪gym_qd_foreign_elites union → digest.nicheMap → flattenDigest niche-map lane. P-007: buildNicheMapPriming 'AVOID crowded/TARGET empty' → ideators → lenses '## Federated niche guidance', gated by owner-steering federatedPriming, foreign text via sanitizeForeignPriming. P-008: buildFederatedSeedPriming analogical recombine + seededByRefs → seededBy: tags on scout_routed_ideas. Tests GREEN: corpus-digest buildFederatedMapLane + 70 Lane-B tests federated-priming/ideator-priming/recombine/cycle/config/novelty-metrics.)",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 2 — generation-time integration (the novelty engine)",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-1757",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          }
        },
        {
          "plan": "federated-scout-gym-learning-2026-07-02",
          "archived": true,
          "item": {
            "id": "P-010",
            "text": "F3-2 Rollout tiers: (1) hive-members-only (existing admission), (2) cross-hive via directory gossip (random-subset elite propagation — log-cost coverage), (3) open network behind the reputation gate. Migration RATE tunable via owner steering (the monoculture-vs-stagnation knob, default small: top-3 + map). (NEW scout/federation-rollout.ts resolveMaxRolloutTier/shareAllowed/federatedShareDecision/gossipFanout/invariant + tier constants + .test.ts 13 pass. NEW flag FLAGS.FEDERATED_SCOUT_LEARNING libs/flags/types.ts — default-ON NOT in DARK_FLAGS: the GITHUB_BRIDGE/P2P kill-switch pattern, activation STRUCTURAL. Tier1 hive-members-only existing F1 admission, safe default / Tier2 cross-hive gossip CROSS_HIVE_GOSSIP_LANDED=false / Tier3 open behind P-009 reputation gate REPUTATION_GATE_LANDED=false → effective tier clamps to 1 until prereqs land, so default-ON ships nothing risky. Tests: 13 rollout + 22 flags-guard pass dark-watermark not tripped, tsc-clean, lint:tsc gate GREEN @224. Egress-consumption seam federatedShareDecision before cross-hive/open push handed to Lane A elite/fact writers agent-facts/store.ts federatableElite path.)",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 3 — trust + rollout + metrics",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-1762",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          }
        }
      ]
    },
    {
      "slug": "gym-real-fitness-signal-2026-07-27",
      "ok": true,
      "status": "ready",
      "archived": false,
      "version": 49,
      "contentHash": "5f2e11c635baab82cfdec63e3ca215ea9127270d6e4cb6bec120d665195452a5",
      "counts": {
        "items": 13,
        "decisions": 18,
        "sections": 7
      },
      "items": [
        {
          "plan": "gym-real-fitness-signal-2026-07-27",
          "archived": false,
          "item": {
            "id": "P-011",
            "text": "Add a `fitness-signal-is-real` criterion to the release-readiness rubric: it FAILS while the active gym corpus is synthetic, reading the corpus label from P-003. A green release gate must be impossible while the thing being optimized is a stub.  — note: fitness-signal-is-real is live as the 7th release bar. VERIFIED against the real DB: verdict flipped pass→FAIL, 'SYNTHETIC FITNESS SIGNAL — 3 of 3 active gym task(s) for papercusp are generated stubs'. Absent corpus rates unknown (never pass); any synthetic task fails; empty corpus is unknown. 61 tests green incl. a guard that the previously-green fixture can no longer close the program",
            "storedStatus": "done",
            "importance": "urgent",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 4 — Make this class of blindness impossible to repeat",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-6296",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          }
        },
        {
          "plan": "gym-real-fitness-signal-2026-07-27",
          "archived": false,
          "item": {
            "id": "P-001",
            "text": "Replace `fixedTasks()`'s synthetic substrate with a REAL task corpus: build `gym_tasks` rows from actual shipped Papercusp work-items that carry verifiable outcomes (a merged diff + its tests + completion evidence), pinned by repoUrl/repoCommit so each task is reproducible. Keep the three-pool split (train / dev-anchor / real-anchor) but populate real-anchor with genuinely-shipped features whose outcome is known — what D-014/P-028 always intended.  — note: ← WI-6286 completed (done)",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [],
            "decisionRefs": [
              "D-014"
            ],
            "phase": "Phase 1 — Make the current loop honest (stop laundering toy results as learning)",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-6286",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-6286",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "gym-real-fitness-signal-2026-07-27",
          "archived": false,
          "item": {
            "id": "P-002",
            "text": "Gate promotion on the real-anchor: a challenger may only be crowned champion if it does not regress the real-anchor pool. Today real-anchor is scored-but-excluded from aggregation, so a prompt can win while getting worse at real work.   — note: ← WI-6287 completed (done)",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [
              "P-001"
            ],
            "decisionRefs": [],
            "phase": "Phase 1 — Make the current loop honest (stop laundering toy results as learning)",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-6287",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-6287",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "gym-real-fitness-signal-2026-07-27",
          "archived": false,
          "item": {
            "id": "P-003",
            "text": "Label every gym artifact with the corpus it was judged on (`taskCorpus: 'synthetic' | 'real'`) in `gym_scores` + on the Gym tab card, so a champion earned on toy tasks can never again read as a champion earned on real work. Backfill existing rows as `synthetic`.  — note: migration 684 (gym_tasks.corpus + gym_proposals.task_corpus, CHECK-constrained, backfilled 'synthetic') applied via db:migrate fence 236; task-corpus.ts vocabulary (10 tests) with one-way default — unknown NEVER reads 'real'; threaded ephemeral DDL → insertTask → durable copy → recordProposal → GymProposalRow.taskCorpus; fixedTasks() now self-labels 'synthetic'",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 1 — Make the current loop honest (stop laundering toy results as learning)",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-6288",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          }
        },
        {
          "plan": "gym-real-fitness-signal-2026-07-27",
          "archived": false,
          "item": {
            "id": "P-004",
            "text": "Arm `LEARNING_GYM_TARGETS`: enable the implement-worker row with an explicit budget via the gym control plane (the owner act the seed file has been waiting for), confirm the `PAPERCUSP_IMPROVEMENT_RUNNER_HARNESS` prerequisite is configured, and verify one cycle judged on `drillResolveRate` / `drillMttsh` / `regressionsFromTests` end-to-end.  — note: PREMISE CORRECTED by the P-012 audit's first live run: implement-worker is not 'seeded dark', it is UNREGISTERED — there is NO gym_autoloop_config row to enable, because PAPERCUSP_IMPROVEMENT_RUNNER_HARNESS is NOT SET and seed-learning-gym-targets.ts skips registration when that prerequisite is missing ('registration never invents a harness slug'). Correct sequence is now: (1) OWNER/config decision — which harness runs auto-implement (PAPERCUSP_IMPROVEMENT_RUNNER_HARNESS); (2) run the seed to create the row; (3) THEN arm it with a budget. Blocked on (1): choosing the runner harness is a topology decision, not an agent call",
            "storedStatus": "blocked",
            "importance": "high",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 2 — Arm the real-signal gym that already exists",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "blocked",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "unclaimed",
            "links": [
              {
                "id": "WI-6289",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": false,
                "blocked": true
              }
            ]
          }
        },
        {
          "plan": "gym-real-fitness-signal-2026-07-27",
          "archived": false,
          "item": {
            "id": "P-005",
            "text": "Wire drill ground truth as the judge: the implement-worker's fitness is planted-drill resolve rate + mean planted→resolved time + repo-test regressions, NOT an LLM composite. Assert the judge reads persisted drill outcomes rather than model opinion.",
            "storedStatus": "todo",
            "importance": "high",
            "blockedBy": [
              "P-004"
            ],
            "decisionRefs": [],
            "phase": "Phase 2 — Arm the real-signal gym that already exists",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "blocked",
            "unresolvedBlockers": [
              "P-004"
            ],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "unclaimed",
            "links": [
              {
                "id": "WI-6290",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": false,
                "blocked": true
              }
            ]
          }
        },
        {
          "plan": "gym-real-fitness-signal-2026-07-27",
          "archived": false,
          "item": {
            "id": "P-007",
            "text": "Design the idea-fitness loop and PRESENT IT BEFORE BUILDING (design-shaped work per standing feedback): ideation output → the `cheapExperiment` already captured on each idea (hypothesis / method / falsifiableSignal) → execute that experiment in a sandbox → score worthiness → feed the score back as the revision signal that wakes the originator. Must name what \"worthiness\" is measured in, what a falsified idea costs, and the per-idea spend ceiling.  — note: ← WI-6292 released",
            "storedStatus": "todo",
            "importance": "high",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 3 — The idea-fitness gym the owner actually asked for",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "todo",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "unclaimed",
            "links": [
              {
                "id": "WI-6292",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": false,
                "blocked": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-6292",
              "state": "open",
              "terminal": false
            }
          ]
        },
        {
          "plan": "gym-real-fitness-signal-2026-07-27",
          "archived": false,
          "item": {
            "id": "P-008",
            "text": "Implement idea-fitness execution: run an idea's cheapExperiment as a real bounded job, persist {ideaId, hypothesis, signal, verdict, cost}, and route the verdict into the existing grade→revision→wake path so a falsified idea gets revised instead of silently graded.",
            "storedStatus": "todo",
            "importance": "high",
            "blockedBy": [
              "P-007"
            ],
            "decisionRefs": [],
            "phase": "Phase 3 — The idea-fitness gym the owner actually asked for",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "blocked",
            "unresolvedBlockers": [
              "P-007"
            ],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "unclaimed",
            "links": [
              {
                "id": "WI-6293",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": false,
                "blocked": true
              }
            ]
          }
        },
        {
          "plan": "gym-real-fitness-signal-2026-07-27",
          "archived": false,
          "item": {
            "id": "P-009",
            "text": "Fix intake starvation: triage routes ~0.6% of ideas to the gym and nothing in 10 days. Instrument why (classifier bias / missing route / unattractive lane), then make idea→gym the DEFAULT for anything cheaply testable rather than an exception.  — note: FIRST HALF DONE (root cause found, see D-005): 'gym' is UNREACHABLE from triageIdea() — 5 branches, returns only place|gate; process-prompt (the self-described \"gym-A/B-able class\") returns gate. Only paths in are a manual Queen override or recurrence-escalation (which also requires the signature to have RECURRED). Not classifier bias — a missing edge. SECOND HALF BLOCKED behind P-007/P-008 per D-005: routing more ideas in today feeds a benchmark P-011 correctly marks RED, yields hint-text not measurement, and would strip the human gate off the compounding class.",
            "storedStatus": "blocked",
            "importance": "high",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 3 — The idea-fitness gym the owner actually asked for",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "blocked",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "unclaimed",
            "links": [
              {
                "id": "WI-6294",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": false,
                "blocked": true
              }
            ]
          }
        },
        {
          "plan": "gym-real-fitness-signal-2026-07-27",
          "archived": false,
          "item": {
            "id": "P-012",
            "text": "Add a dark-target audit to the standing cert: any registered learning target seeded dark that has never run must be reported every wake, not silently skipped. `LEARNING_GYM_TARGETS` sat dark for weeks with zero surfacing.  — note: dark-target-audit.ts + 7 tests. Reports the 4 distinct no-signal reasons (unregistered/disabled/unbudgeted/never-ran), most-severe first, and EXCLUDES non-prompt-override targets by design instead of crying wolf (listing them so 'excluded' never looks like 'missing'). FIRST LIVE RUN CORRECTED P-004 — see that item's note",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 4 — Make this class of blindness impossible to repeat",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-6297",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          }
        },
        {
          "plan": "gym-real-fitness-signal-2026-07-27",
          "archived": false,
          "item": {
            "id": "P-006",
            "text": "Decide and record whether the coding-role prompt gym (worker/director/orchestrator) stays armed once real targets run — it currently spends budget on toy tasks. Options: retire it, re-point it at P-001's corpus, or park it dark.   — note: ← WI-6291 completed (done)",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [
              "P-001"
            ],
            "decisionRefs": [],
            "phase": "Phase 2 — Arm the real-signal gym that already exists",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-6291",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-6291",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "gym-real-fitness-signal-2026-07-27",
          "archived": false,
          "item": {
            "id": "P-010",
            "text": "Close the loop back to ideation: an idea that survives its experiment becomes a ranked, evidence-carrying placement candidate; one that fails carries its falsification so the same idea is not re-proposed.",
            "storedStatus": "todo",
            "importance": "normal",
            "blockedBy": [
              "P-008"
            ],
            "decisionRefs": [],
            "phase": "Phase 3 — The idea-fitness gym the owner actually asked for",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "blocked",
            "unresolvedBlockers": [
              "P-008"
            ],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "unclaimed",
            "links": [
              {
                "id": "WI-6295",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": false,
                "blocked": true
              }
            ]
          }
        },
        {
          "plan": "gym-real-fitness-signal-2026-07-27",
          "archived": false,
          "item": {
            "id": "P-013",
            "text": "Write the agent-insight doc: \"a green mechanism gate over a synthetic benchmark is not learning\" — the trap, how it survived six scorecards, and the check that catches it.  — note: Written + built + served: agent-insights/a-green-mechanism-gate-over-a-synthetic-benchmark-is-not-learning. Covers the trap, how it survived six scorecards, and 4 checks in cost order.",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 4 — Make this class of blindness impossible to repeat",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-6298",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          }
        }
      ]
    },
    {
      "slug": "gym-repoint-live-coding-and-visible-runs-2026-07-20",
      "ok": true,
      "status": "awaiting-acceptance",
      "archived": true,
      "version": 24,
      "contentHash": "82972f835304579ca4ee9ab5bc2d7ae135f610c5fe6987bc32a1a4cab6239704",
      "counts": {
        "items": 10,
        "decisions": 0,
        "sections": 6
      },
      "items": [
        {
          "plan": "gym-repoint-live-coding-and-visible-runs-2026-07-20",
          "archived": true,
          "item": {
            "id": "P-001",
            "text": "Scope the repoint: read how the gym invokes the harness-under-test (autoloop-cycle.ts, loop-deps.ts, boot-spec.ts, wake-mode.ts:84, blueprint-cycle.ts writeHarnessTree) and decide `extends:` swap vs Hive+bee spawn integration — note: Scoping complete: gym substrate had no blueprint → coding-factory fallback; target = coding-solo (live single-worker, gym seam). Verified as config change.",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 1 — Repoint the gym to the live coding system",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          }
        },
        {
          "plan": "gym-repoint-live-coding-and-visible-runs-2026-07-20",
          "archived": true,
          "item": {
            "id": "P-002",
            "text": "Repoint external-bench + gym hardcodes from `coding-factory` to `coding` (external-bench/blueprint.yaml:40, gym/wake-mode.ts:84, any other gym refs), and refresh external-bench's stale role-list comments  — note: ← WI-5648 done",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [
              "P-001"
            ],
            "decisionRefs": [],
            "phase": "Phase 1 — Repoint the gym to the live coding system",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-5648",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-5648",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "gym-repoint-live-coding-and-visible-runs-2026-07-20",
          "archived": true,
          "item": {
            "id": "P-003",
            "text": "If the gym cycle machinery assumes the fixed-spine role sequence, adapt it to run the Hive+bee model the way the live system spawns coding agents (mimic operator-spawn)  — note: ← WI-5649 done",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [
              "P-001"
            ],
            "decisionRefs": [],
            "phase": "Phase 1 — Repoint the gym to the live coding system",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-5649",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-5649",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "gym-repoint-live-coding-and-visible-runs-2026-07-20",
          "archived": true,
          "item": {
            "id": "P-004",
            "text": "Verify a full gym cycle completes against the live `coding` target (roles reflect Queen+bee, not director→curator; cycle records a result)  — note: Fake cycle (bg b9yo14mrd) verified: role=worker x4 (coding-solo), spine roles gone, GYM-LOOP OK, 1 proposal promoted. Real-mode confirmation comes on the next system gym-cycle tick (gym runs tsx from staging, no deploy needed).",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [
              "P-002",
              "P-003"
            ],
            "decisionRefs": [],
            "phase": "Phase 1 — Repoint the gym to the live coding system",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          }
        },
        {
          "plan": "gym-repoint-live-coding-and-visible-runs-2026-07-20",
          "archived": true,
          "item": {
            "id": "P-010",
            "text": "Study how run/agent execution is persisted elsewhere in the repo and design the gym run-DB persistence to mimic it (not a throwaway testcontainer)  — note: Design: mirror control-plane's live-DB persistence — new live migration 650 creates harness_gym in the LIVE operator DB, (workspace,harness)-scoped composite keys, no FKs; cycle-end copy step; reads via the live pool (no separate gym DB / env needed).",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [
              "P-004"
            ],
            "decisionRefs": [],
            "phase": "Phase 2 — Persist run analytics + wire the UI (option A)",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-5655",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          }
        },
        {
          "plan": "gym-repoint-live-coding-and-visible-runs-2026-07-20",
          "archived": true,
          "item": {
            "id": "P-011",
            "text": "Persist gym cycle run analytics (cycles/variants/frontier) to a durable gym run DB instead of the per-cycle testcontainer that gets torn down  — note: Migration 650 + store.copyRunAnalyticsToDurable (cycle-end copy, jsonb-passthrough) + scoped durable readers + wired into runOneAutoloopCycle + routes read via live pool. 2 integration tests + 5 UI tests green; tsc clean.",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [
              "P-010"
            ],
            "decisionRefs": [],
            "phase": "Phase 2 — Persist run analytics + wire the UI (option A)",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          }
        },
        {
          "plan": "gym-repoint-live-coding-and-visible-runs-2026-07-20",
          "archived": true,
          "item": {
            "id": "P-012",
            "text": "Configure `PAPERCUSP_GYM_DATABASE_URL` on the :3070 operator (and staging) pointing at the durable gym run DB  — note: SUPERSEDED (better design, disclosed): reads go through the live routeWithWorkspace pool, so NO PAPERCUSP_GYM_DATABASE_URL env/service-config needed — works on every operator, no connection churn, no SSRF surface. Migration auto-applies on operator restart.",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [
              "P-011"
            ],
            "decisionRefs": [],
            "phase": "Phase 2 — Persist run analytics + wire the UI (option A)",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          }
        },
        {
          "plan": "gym-repoint-live-coding-and-visible-runs-2026-07-20",
          "archived": true,
          "item": {
            "id": "P-013",
            "text": "Verify the Cycles/Variants/Frontier tabs populate in the Tauri UI after a real cycle  — note: Verified end-to-end (data layer + render): real fake cycle GYM-LOOP OK + copied to live DB; exact harness_app+RLS route read path confirmed against real data (correct-ws→rows, wrong-ws→0); UI render via GymDashboard jsdom test + 13-test route suite. Live Tauri pixel-drive not run (equivalent verification done; deploy to :3070 flowing via pipeline).",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [
              "P-012"
            ],
            "decisionRefs": [],
            "phase": "Phase 2 — Persist run analytics + wire the UI (option A)",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-5659",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          }
        },
        {
          "plan": "gym-repoint-live-coding-and-visible-runs-2026-07-20",
          "archived": true,
          "item": {
            "id": "P-020",
            "text": "Fix the proposals view so auto-promoted/decided challengers are visible (default `status=all` or add a recent-activity view) instead of the pending-only default that hides everything  — note: Proposals tab now defaults to status=all (gym auto-decides, so pending-only hid every challenger); rows show status pill, accept/reject gated to pending. UI test added.",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [
              "P-004"
            ],
            "decisionRefs": [],
            "phase": "Phase 3 — Proposals-tab visibility",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          }
        },
        {
          "plan": "gym-repoint-live-coding-and-visible-runs-2026-07-20",
          "archived": true,
          "item": {
            "id": "P-005",
            "text": "Address the live fallback refs to retired coding-factory (blueprint-run-action.ts:204, orchestrator-workflow.ts:281) — repoint or file/track separately  — note: Owner-directed. codingFallback() + codingSpine() repointed coding-factory→coding-solo. 146 tests green (blueprint-run-action, derive-next-equivalence, orchestrator-runner/finalize, installed-blueprints, registry-validation, detect-from-repo). Repoint not remove (papercup relies on it). Peer WI-5645 notified.",
            "storedStatus": "done",
            "importance": "low",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 1 — Repoint the gym to the live coding system",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-5653",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-5645",
              "state": "done",
              "terminal": true
            }
          ]
        }
      ]
    },
    {
      "slug": "gym-unwedge-scout-novelty-2026-07-02",
      "ok": true,
      "status": "draft",
      "archived": true,
      "version": 24,
      "contentHash": "38706e82410aa4f155672375844da6720920838127d046b63eae9e89d49bcad2",
      "counts": {
        "items": 5,
        "decisions": 0,
        "sections": 7
      },
      "items": [
        {
          "plan": "gym-unwedge-scout-novelty-2026-07-02",
          "archived": true,
          "item": {
            "id": "P-002",
            "text": "GYM-2 chronic-failure escalator (generalize, not gym-specific): any autoloop_state row with consecutive_errors > threshold (default 6) files an improvements observation + wakes overwatch, once per breach (debounced via the hive_watchdog_fires pattern). A cycle silently dead 12 days (gym) = same detector-gap class as the plan-rail pending-rot (WI-1574). Tests; wire on routinesTick next to the other sweeps in dbos/routines-workflow.ts.  (Duplicate of autonomous-loop-prod-audit-2026-07-02#P-012; already implemented — autoloopChronicFailureSweep autoloop-chronic-failure.ts is wired into dbos/routines-workflow.ts:757-758 in production. Verified via EI-12537.)",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": null,
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "citedWorkItems": [
            {
              "ref": "WI-1574",
              "state": "done",
              "terminal": true
            },
            {
              "ref": "EI-12537",
              "state": "resolved",
              "terminal": true
            }
          ]
        },
        {
          "plan": "gym-unwedge-scout-novelty-2026-07-02",
          "archived": true,
          "item": {
            "id": "P-003",
            "text": "GYM-3 verify outcome wiring end-to-end: scout/eval-verdict-wire.ts must flip scout_routed_ideas.outcome for gym verdicts; change-feed must flip plan/improvement routes. Evidence: 11 routed ideas ALL-TIME — 2 won (improvement, June), 9 pending (all 6 plan routes + all gym routes). ACCEPTANCE: pending routes resolve or escalate; the outcome-feedback lens-weight tally SHIFTS after the next outcome (scout/outcome-feedback.ts; grading already works, 8/11).  (Verified live via DB query: gym-rail scout_routed_ideas outcomes 100% resolved 50 won/24 lost/0 pending; plan-rail 5 lost/1 pending. scout_lens_weights shows active non-uniform tally shifts across 3 recent timestamps 07-16 20:28 → 07-17 00:18. Acceptance criteria met.)",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 1 — TODO",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          }
        },
        {
          "plan": "gym-unwedge-scout-novelty-2026-07-02",
          "archived": true,
          "item": {
            "id": "P-004",
            "text": "NOV-1 QD-guided ideation: prime the scout ideator with gym_qd_archive state — crowded niches (avoid) + EMPTY niches (propose here). Generation is currently BLIND to the archive; this is the core quality-diversity feedback the design intends. Seam: scout/corpus-digest.ts or scout/ideator-priming.ts / ideator-feedback-priming.ts (priming plumbing exists for lens feedback — extend, do not fork).  (Verified shipped: nicheMap field populated in cycle-deps.ts readCorpus crowded+empty niches from gym_qd_archive, buildNicheMapPriming emits both AVOID-crowded and TARGET-empty guidance, injected into ideator system prompt via lenses.ts nicheMapPriming, consumed by ideators.ts. 27/27 cycle-deps + ideator-priming tests green.)",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 1 — close the outcome circuit",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          }
        },
        {
          "plan": "gym-unwedge-scout-novelty-2026-07-02",
          "archived": true,
          "item": {
            "id": "P-005",
            "text": "NOV-2 exogenous stimuli in the corpus digest: cross-hive corpora, telemetry anomalies, recent-commit digests, deprecated-draft salvage (deprecate-with-learnings observations) — external entropy so ideation is not resampling the same internal pool. (Verified shipped under a sibling plan: exogenous-commit-lane.ts NOV-2, autonomous-loop-prod-audit-2026-07-02 P-015/WI-4635 supplies the 4th stimulus recent-commit digests; its own header confirms the other 3 cross-hive corpora via unscoped friction/observation readers, telemetry anomalies via blender-self-learning P-007/8/9/10/11 lanes, deprecated-draft salvage via deprecate-learnings.ts were already live. 13/13 exogenous-commit-lane tests green; recentCommits wired end-to-end into corpus-digest→lenses→ideators.)",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 1 — close the outcome circuit",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "citedWorkItems": [
            {
              "ref": "WI-4635",
              "state": "passed",
              "terminal": true
            }
          ]
        },
        {
          "plan": "gym-unwedge-scout-novelty-2026-07-02",
          "archived": true,
          "item": {
            "id": "P-006",
            "text": "NOV-3 throughput + selection: raise scout budget (learning:set-scout-budget; g=3/tick produced 11 ideas ALL-TIME — no evolutionary pressure); keep critics/quality-metrics + grading as the filter. NOV-4 champion escalation: gym champions (gym_champion_outcomes) auto-file improvement work items into the queen frontier so gym wins become placed work. (Verified shipped: packages/operator-core/lib/scout/ideators.ts default raised 3→4 + PAPERCUSP_SCOUT_MAX_IDEAS_PER_IDEATOR env override; 4/4 NOV-3 tests green ideators.test.ts.)",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 1 — close the outcome circuit",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          }
        }
      ]
    },
    {
      "slug": "rem-dream-recombination-2026-08-17",
      "ok": true,
      "status": "ready",
      "archived": false,
      "version": 142,
      "contentHash": "3cd3fb665483489557144740ff99ff86f4ffe543fa1ed757e8bb5b9f7b10eb64",
      "counts": {
        "items": 24,
        "decisions": 28,
        "sections": 19
      },
      "items": [
        {
          "plan": "rem-dream-recombination-2026-08-17",
          "archived": false,
          "item": {
            "id": "P-018",
            "text": "Preserve distinct scientific outcomes across existing run/read/metrics/history UI, including legacy rejected+unverified rows; fix EI-24370478037488320 with orchestration and UI/metrics regression tests.  — note: ← WI-10003376 completed (done)",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 5 — Evidence-led usefulness and shipment",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-10003376",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "EI-24370478037488320",
              "state": "done",
              "terminal": true
            },
            {
              "ref": "WI-10003376",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "rem-dream-recombination-2026-08-17",
          "archived": false,
          "item": {
            "id": "P-019",
            "text": "Make unresolved review actionable: dependency preflight before generation, explicit missing-evidence/next-check records, and bounded evidence resolution that preserves review independence, source freshness and spend limits.  — note: ← WI-10003377 completed (done)",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 5 — Evidence-led usefulness and shipment",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-10003377",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-10003377",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "rem-dream-recombination-2026-08-17",
          "archived": false,
          "item": {
            "id": "P-020",
            "text": "Ground capability proposals in attributable observed problems and unmet requirements; retain open exploration, validate source context and beneficiary/delta, and test prompt/provenance behavior without automatic work creation.  — note: ← WI-10003378 completed (done)",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 5 — Evidence-led usefulness and shipment",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-10003378",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-10003378",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "rem-dream-recombination-2026-08-17",
          "archived": false,
          "item": {
            "id": "P-021",
            "text": "Expand the existing reviewed capability manifest using problem-relevant source/test anchors, integration contracts and limitations; expose partial catalogue coverage and verify all added packets against the registered repository.  — note: ← WI-10003379 completed (done)",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 5 — Evidence-led usefulness and shipment",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-10003379",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-10003379",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "rem-dream-recombination-2026-08-17",
          "archived": false,
          "item": {
            "id": "P-022",
            "text": "Distinguish rediscovery/refinement utility from new-discovery credit; link existing proposal-family/prior-work references without duplicate routed work; preserve historical outcomes and test truthful metrics/read/UI.  — note: ← WI-10003380 completed (done)",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 5 — Evidence-led usefulness and shipment",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-10003380",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-10003380",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "rem-dream-recombination-2026-08-17",
          "archived": false,
          "item": {
            "id": "P-023",
            "text": "Run a small calibrated comparable-input/spend evaluation through existing Dream/Blender/experiment mechanisms; retain immutable prior study, human review gate, attributed model/reviewer/maintenance costs, source and outcome evidence. Aim for one grounded proposal and measured beneficial experiment; explicitly inconclusive if benefit is not demonstrated.  — note: Independent human blind-v2 calibration prerequisite is not met; source D023/calibration-status.md retain this contract. See WI-10003381 checkpoint; leader routing actual reviewer.",
            "storedStatus": "needs-human",
            "importance": "high",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 5 — Evidence-led usefulness and shipment",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "needs-human",
            "unresolvedBlockers": [],
            "needsHuman": true,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "unclaimed",
            "links": [
              {
                "id": "WI-10003381",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": false,
                "blocked": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-10003381",
              "state": "blocked",
              "terminal": false
            }
          ]
        },
        {
          "plan": "rem-dream-recombination-2026-08-17",
          "archived": false,
          "item": {
            "id": "P-024",
            "text": "Verify native Start/Pause/resume/history/Analyze journeys on current build, complete item audits and independent acceptance, and confirm green-main deployment before claiming shipped. Human labels and scientific benefit must never be self-certified.  — note: Agent-doable legs verified 2026-10-02T04:53Z by su-5930d3f6: no Dream source change since native evidence commit 36e3f8e6e (run20350343, bindings 17936/17937/17938 stand); Dream cycle+panel inMain/deployed/live (dev:pipeline_position). Remaining legs need an independent reviewer or human and must not be self-certified: blind calibration/scientific acceptance, P-008 labels, P-023, BAR vetting. Owner ask conv-mup3a7ee-0000-7e5a0e27e4974a38b69888d0ddfc9bd2 still open. Route unchanged per D-023/D-025.",
            "storedStatus": "needs-human",
            "importance": "high",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 5 — Evidence-led usefulness and shipment",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "needs-human",
            "unresolvedBlockers": [],
            "needsHuman": true,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "unclaimed",
            "links": [
              {
                "id": "WI-10003382",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": false,
                "blocked": true
              }
            ]
          }
        },
        {
          "plan": "rem-dream-recombination-2026-08-17",
          "archived": false,
          "item": {
            "id": "P-001",
            "text": "Fragment sampler: stratified draw over indexed high-signal strata (session turns, decisions, completions-with-evidence, escalations, observations, memories per Q1), pairing one RECENT fragment (~48h, salience-weighted) with one REMOTE fragment; embedding mid-band distance filter (too-close = trivially related, too-far = incoherent); excludes low-signal turn types (tool spam). Pure module + unit tests over a fixture corpus. — note: ← WI-40121 completed (done)",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 0 — existing fragment-engine foundation",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-40121",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-40121",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "rem-dream-recombination-2026-08-17",
          "archived": false,
          "item": {
            "id": "P-002",
            "text": "Dream pass: one bounded cheap-model call per dream — 2–3 fragments, \"produce at most ONE operationally useful insight that requires BOTH fragments (cite what each contributes), or answer NONE\"; abstention is a first-class parsed outcome; malformed output rejected.  — note: ← WI-40123 completed (done)",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [
              "P-001"
            ],
            "decisionRefs": [],
            "phase": "Phase 0 — existing fragment-engine foundation",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-40123",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-40123",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "rem-dream-recombination-2026-08-17",
          "archived": false,
          "item": {
            "id": "P-003",
            "text": "Review gate: independent grader call (grader ≠ dreamer, per Q3): juxtaposition-dependence test first, then actionability/falsifiability, then novelty vs. corpus (embedding dedupe against blender corpus + memories); reject-by-default calibration.  — note: ← WI-40127 completed (done)",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [
              "P-002"
            ],
            "decisionRefs": [],
            "phase": "Phase 0 — existing fragment-engine foundation",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-40127",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-40127",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "rem-dream-recombination-2026-08-17",
          "archived": false,
          "item": {
            "id": "P-004",
            "text": "Sink: accepted insights land in the blender corpus as idea rows with origin='dream' + provenance refs to the source fragments; they enter the existing blender grade/route/outcome machinery unchanged (reuse-first — no parallel pipeline). — note: ← WI-40133 completed (done)",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 0 — existing fragment-engine foundation",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-40133",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-40133",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "rem-dream-recombination-2026-08-17",
          "archived": false,
          "item": {
            "id": "P-011",
            "text": "Capability contracts and seed catalog. Define stable domain/capability/mechanism IDs and a versioned packet schema with purpose, mechanism, evaluation, inputs/outputs/events/state, guarantees, constraints, implementation/test refs, source hashes and extraction provenance. Derive domain links from the existing testing registry and package/docs anchors; start with a small reviewed cross-domain catalog and document unmapped regions. Capability boundaries follow observable behavior, may span files, and record overlap/parentage. Acceptance: schema fixtures reject unsupported claims/missing required provenance; every pilot unit resolves its implementation and meaningful tests; no complete-coverage claim from test globs alone. Research R1–R3/R9; D-009. — note: ← WI-10000483 completed (done)",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 1 — capability packets, sampling and review",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-10000483",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-10000483",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "rem-dream-recombination-2026-08-17",
          "archived": false,
          "item": {
            "id": "P-012",
            "text": "Build bounded capability packets and an incremental cache using existing code-intelligence facades and code:pack. Resolve symbols, caller/callee radius and tests; preserve source excerpts plus purpose/mechanism/evaluation facets. Hash actual file bytes, contracts, extraction recipe and prompt versions; record dirty state and coverage/truncation. Revalidate cited sources before review/admission; refresh changed packets without re-embedding unchanged ones. Use verified LSP/ripgrep fallback when graph health is unknown; absence of an edge never proves no integration. Acceptance: edit/rename/delete and dirty-tree fixtures invalidate correctly, packet budgets preserve contracts, and secrets/untrusted-instruction fixtures fail safely. D-009.  — note: ← WI-10000484 completed (done)",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [
              "P-011"
            ],
            "decisionRefs": [],
            "phase": "Phase 1 — capability packets, sampling and review",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-10000484",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-10000484",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "rem-dream-recombination-2026-08-17",
          "archived": false,
          "item": {
            "id": "P-013",
            "text": "Hierarchy-aware, reproducible pair/triple sampler. Choose domains before units with bounded underexploration weighting; mix structural cross-domain, uniform cross-domain and same-domain/different-branch strategies (initial 50/30/20 settings). Two primary units are required; optional C has constraint/consumer/enabling-mechanism role (initial 20% setting). Preserve pure-random control, eligibility/probability/seed logging, unordered content-version pair cooldown with transfer direction retained, sparse-domain fallback and no-pair outcome. Capability×capability and capability×mechanism are primary recipes; subsystem-level experiments are explicitly tagged; >=4 units deferred. Acceptance: deterministic quota, coverage, arity, cross-scope exclusion, cooldown and missing-candidate tests. Research R1–R5; settings are hypotheses.  — note: ← WI-10000485 completed (done)",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [
              "P-012"
            ],
            "decisionRefs": [],
            "phase": "Phase 1 — capability packets, sampling and review",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-10000485",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-10000485",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "rem-dream-recombination-2026-08-17",
          "archived": false,
          "item": {
            "id": "P-014",
            "text": "Extend the dream prompt and strict versioned result schema. Produce zero or one candidate with observed evidence separated from hypothesis, beneficiary, behavior, unique A/B contributions, explicit relation mapping, optional C role, source refs, assumptions, prior-art delta and a minimal experiment with falsifier. Preserve first-class abstention and malformed outcomes; retain a compatibility mapping between NO_CONNECTION semantics and existing verdict:none. All text fields are bounded; no silent truncation into misleading evidence. Generator cannot modify code or create implementation work. Acceptance: missing/empty contribution, unsupported reference, optional-C decorative use, prompt injection, overflow and abstention fixtures. Research R1–R3/R6; D-009.  — note: ← WI-10000486 completed (done)",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [
              "P-012"
            ],
            "decisionRefs": [],
            "phase": "Phase 1 — capability packets, sampling and review",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-10000486",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-10000486",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "rem-dream-recombination-2026-08-17",
          "archived": false,
          "item": {
            "id": "P-015",
            "text": "Independent source verifier and skeptical reviewer. Retrieve relevant code/tests and prior Blender ideas/plans/rejected attempts by purpose/mechanism/evaluation facets; rerank and compare claimed behavior. Exact duplicate IDs/hashes can reject cheaply; semantic similarity is evidence for adjudication, not a universal novelty threshold. Require fresh supporting sources, both-unit counterfactual checks, feasibility/constraint analysis and executable falsifier; use fresh reviewer context and preserve the existing different-model guard. Record search scope/coverage and unknown separately from disproven/duplicate. Acceptance: known integration hidden behind naming changes, subtly distinct proposal, missing source, stale hash, one-unit-only, mechanism-transfer and constraint-conflict fixtures; grounded reject notes. Research R2/R3/R6/R7/R8.  — note: ← WI-10000487 completed (done)",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [
              "P-014"
            ],
            "decisionRefs": [],
            "phase": "Phase 1 — capability packets, sampling and review",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-10000487",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-10000487",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "rem-dream-recombination-2026-08-17",
          "archived": false,
          "item": {
            "id": "P-016",
            "text": "Extend existing dream_runs and Blender sink provenance without a second idea pipeline. Store packet/version refs, source manifest hashes, sampled recipes/seed/probabilities, arity/C role, prompt/model versions, abstentions/rejection reasons, source-verification evidence, candidate/prior-art delta and all phase costs. Preserve old rows, write-once terminal results, replay/idempotency and dream:<runId> identity. Reviewed proposals enter the established Blender triage path; a grade or dream-review pass does not approve a plan or its implementation. Acceptance: old/new rows deserialize, crash/retry produces one sink record, stale source cannot pass admission, nonaccepted runs do not sink, and costs reconcile to the governed calls. D-009.  — note: ← WI-10000488 completed (done)",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [
              "P-014",
              "P-015"
            ],
            "decisionRefs": [],
            "phase": "Phase 1 — capability packets, sampling and review",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-10000488",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-10000488",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "rem-dream-recombination-2026-08-17",
          "archived": false,
          "item": {
            "id": "P-005",
            "text": "Complete and verify cycle integration for capability packets and the revised sampler/reviewer/ledger; inventory existing dream-cycle/action/governor implementations first. Preserve manual Start/Pause, cancellation, feature surface default ON and a separate default-OFF automatic setting (D-001/D-009). Account for packet build/refresh, retrieval, generator, verifier and reviewer work using existing governor admission and reconciliation; distinguish admission ceilings from strict actual-cost guarantees. Acceptance: current-build mocked/integration tests for manual/auto/pause/abort, scope, replay, error accounting and limit exhaustion; no change auto-enables paid cycles.  — note: ← WI-40138 completed (done)",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [
              "P-013",
              "P-015",
              "P-016"
            ],
            "decisionRefs": [],
            "phase": "Phase 2 — integration and manual controls",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-40138",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true,
                "blocked": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-40138",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "rem-dream-recombination-2026-08-17",
          "archived": false,
          "item": {
            "id": "P-009",
            "text": "Complete and verify Learning-tab dream controls using existing registry components and sync conventions: Start/Pause, current progress, cost, last-cycle result, separate Auto-dream toggle default OFF, and actionable missing-source/budget/reviewer state. Preserve user-meaningful URL state and push invalidation. Inspect current UI/read surfaces before adding any. Acceptance: current-build user journey covers manual start, pause, resume/retry semantics, budget stop and no spontaneous auto run; fixtures enforce separate feature/automatic settings.  — note: ← WI-40143 completed (done)",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [
              "P-005"
            ],
            "decisionRefs": [],
            "phase": "Phase 2 — integration and manual controls",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-40143",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-40143",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "rem-dream-recombination-2026-08-17",
          "archived": false,
          "item": {
            "id": "P-006",
            "text": "Extend existing Dream/Blender metrics and reads: versioned attempts and all terminal outcomes, explicit funnel denominators, source/packet coverage, unique behavior-family novelty, usefulness/feasibility, arity/recipe breakdown, reviewer disagreement, indexing and model cost, cold-start/amortized cost, experiment results and downstream grade/route/outcomes. Keep quality dimensions separate and reconcile from the durable ledger; missing usage remains unknown. Acceptance: fixture totals reconcile without counting retries or reworded duplicates as new proposals; old rows remain readable.  — note: ← WI-40146 completed (done)",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [
              "P-005",
              "P-016"
            ],
            "decisionRefs": [],
            "phase": "Phase 3 — measurement and benchmark calibration",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-40146",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-40146",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "rem-dream-recombination-2026-08-17",
          "archived": false,
          "item": {
            "id": "P-010",
            "text": "Complete Analyze/Dreams visibility through existing sync/read surfaces: domain/unit selection, A/B contributions and optional C role, code/test links, source version/freshness, prior-art differences, falsifier, review notes, all rejections/abstentions and phase costs. Accepted proposals remain discoverable in ordinary Ideas/routed views; raw Observations retain their established meaning. Acceptance: current-build fixture/journey verifies old/new rows, empty/unknown/error states, correct metric denominators and drill-through provenance without hand-rolled polling.  — note: ← WI-40145 completed (done)",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [
              "P-006"
            ],
            "decisionRefs": [],
            "phase": "Phase 3 — measurement and benchmark calibration",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-40145",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-40145",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "rem-dream-recombination-2026-08-17",
          "archived": false,
          "item": {
            "id": "P-017",
            "text": "Prepare the benchmark and freeze the evaluation protocol before the paid pilot. Use existing test/experiment infrastructure; include curated positive transfers, already-built integrations, impossible compositions, lexical-only associations, A-only/B-only controls, irrelevant C and stale/missing evidence. Independently label the cases and validate the reviewer against held-out cases; preserve failures for calibration. Pre-register matched-spend Blender/random-pair/structured-pair/structured-triple arms, sampling and source snapshots, utility rubric, accounting, stop limits and inconclusive outcome. Acceptance: reproducible harness tests plus a reviewer confusion matrix and a recorded protocol; fixture validity is reviewed, not inferred from the generator's answer. See Evaluation protocol; research R4/R6–R8/R10/R11.  — note: ← WI-10000489 completed (done)",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [
              "P-013",
              "P-015",
              "P-016"
            ],
            "decisionRefs": [],
            "phase": "Phase 3 — measurement and benchmark calibration",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-10000489",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-10000489",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "rem-dream-recombination-2026-08-17",
          "archived": false,
          "item": {
            "id": "P-007",
            "text": "Calibrate quality detection against P-017 fixtures and held-out judgments: false accept/reject behavior, missing/stale evidence, repeated-family concentration, cost anomalies and unresolved reviews. Acceptance/abstention rates remain diagnostics, not target quotas; remove the earlier fixed ~20% pass-rate rule from the new design. Sample rejected proposals to detect overstrict review. Acceptance: detector tests flag corrupted fixtures and accounting/freshness faults while leaving a genuinely high-quality batch unflagged solely for its pass rate. Reuse the existing watchdog path.  — note: ← WI-40147 completed (done)",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [
              "P-006",
              "P-017"
            ],
            "decisionRefs": [],
            "phase": "Phase 3 — measurement and benchmark calibration",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-40147",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-40147",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "rem-dream-recombination-2026-08-17",
          "archived": false,
          "item": {
            "id": "P-008",
            "text": "Execute the pre-registered matched-spend comparison and bounded downstream experiment sample in the Evaluation protocol after separate implementation approval and budget confirmation. Compare ordinary Blender, uniform pairs, structural pairs and role-labeled triples; report full cost, unique verified useful proposals, confidence/coverage, actual outcomes and sample exclusions. The exploratory 200-attempt/USD20 discovery ceiling is not a statistical power claim or approval to spend. Acceptance: reproducible evidence report plus a keep/simplify/expand/stop or explicitly inconclusive disposition; no closure from acceptance rate alone. Final shipment follows current ownership/frozen-candidate release rules, not the old historical candidates.  — note: Awaiting the existing independent human/domain calibration reviewer or six blind-v2 judgments at conv-mttzunb3-0000-bb2e27dc90544bb1bcdd9bc787f16e70; no paid calls before calibration. This reflects the existing checkpoint/protocol blocker, not a new requirement.",
            "storedStatus": "needs-human",
            "importance": "normal",
            "blockedBy": [
              "P-007",
              "P-009",
              "P-010",
              "P-017"
            ],
            "decisionRefs": [],
            "phase": "Phase 4 — controlled pilot and decision",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "needs-human",
            "unresolvedBlockers": [],
            "needsHuman": true,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "unclaimed",
            "links": [
              {
                "id": "WI-40148",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": false,
                "blocked": true
              }
            ]
          }
        }
      ]
    },
    {
      "slug": "scorecard-blender-pipeline-fixes-2026-07-11",
      "ok": true,
      "status": "draft",
      "archived": true,
      "version": 65,
      "contentHash": "801a30b2c36c6b6d20d499844e4fb7f67d249435700dcdd6a006d98272c8568a",
      "counts": {
        "items": 1,
        "decisions": 4,
        "sections": 6
      },
      "items": [
        {
          "plan": "scorecard-blender-pipeline-fixes-2026-07-11",
          "archived": true,
          "item": {
            "id": "P-001",
            "text": "Cycle reliability: root-cause ideator transport deaths (50×/7d: 429 rate-limits + 180s timeouts — verify gateway pooling/failover on scout ideator LLM calls), segment phase timeouts (600s whole-cycle hit in critique/route/recombine), add error-streak alarm (circuit gate exists but pages nobody)  (← WI-4274 released) (WI-4274 error-streak alarm shipped+verified) (← WI-4274 completed resolved)",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase — Fixes",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-4274",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-4274",
              "state": "done",
              "terminal": true
            }
          ]
        }
      ]
    },
    {
      "slug": "scout-idea-grading-2026-06-12",
      "ok": true,
      "status": "superseded",
      "archived": false,
      "version": 24,
      "contentHash": "97c1e470959dd9b3021dc993d3b5a3eec63a39c1369d84e40423e88a578d9d10",
      "counts": {
        "items": 10,
        "decisions": 7,
        "sections": 10
      },
      "items": [
        {
          "plan": "scout-idea-grading-2026-06-12",
          "archived": false,
          "item": {
            "id": "P-001",
            "text": "Migration per C-1 + pull-schema. (Brief B-01) (B-01 landed: mig 234-scout-idea-grading.sql number via db:next-migration — 233 was taken on disk runner-applied to the live DB with schema_migrations ledger row; 4 columns + 1–5 CHECK verified; pull-schema regenerated generated.ts. Gates: lint:migrations 127 clean, routed-ledger 5/5 + cycle-real-rails 7/7 + corpus-digest-deps 4/4 integration green fresh-migrate proven, db-boot-migrate 5/5.)",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 1 — Storage + write path",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          }
        },
        {
          "plan": "scout-idea-grading-2026-06-12",
          "archived": false,
          "item": {
            "id": "P-002",
            "text": "`gradeRoutedIdea` per C-2 + ledger readers (`readRoutedIdeas` maps C-1 → C-1b) + `learning-scout-read` snapshot per C-1c + invalidate. (Brief B-02) (B-02 landed: gradeRoutedIdea C-2 + C-1b read mapping + C-1c snapshot grade fields + lensWeights; unit 4 + resolver 12 + integration 10/10 green, tsc ratchet green)",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 1 — Storage + write path",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          }
        },
        {
          "plan": "scout-idea-grading-2026-06-12",
          "archived": false,
          "item": {
            "id": "P-003",
            "text": "`scout:grade-idea` tool per C-3 + UI proxy path + unit tests incl. owner-precedence no-op. (Brief B-03) (scout:grade-idea landed B-03: C-3 over C-2 + D-007 routedRef key; 18 unit tests, tools-md-sync, guidance-budget, test:affected green)",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 1 — Storage + write path",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          }
        },
        {
          "plan": "scout-idea-grading-2026-06-12",
          "archived": false,
          "item": {
            "id": "P-004",
            "text": "Fractional outcome credit per C-5 in outcome-feedback + tests (credit math, grade-dominates, ungraded unchanged, errored-stays-pending). (Brief B-04) (B-04 landed: C-1b provenance fields + winCredit/grade-dominates tally in computeLensOutcomes; classifyIdeaOutcome grade-blind per D-002; refreshScoutOutcomes unchanged; 15 new tests, test:affected green su-a1ec6)",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 2 — Feed grades back into Scout",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          }
        },
        {
          "plan": "scout-idea-grading-2026-06-12",
          "archived": false,
          "item": {
            "id": "P-005",
            "text": "`gatherGraderFeedbackPriming()` per C-4 + cycle-deps concat + hermetic prompt test. (Brief B-05) (B-05 landed — gatherGraderFeedbackPriming C-4 + cycle-deps concat + hermetic tests, scout suite 467 green)",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 2 — Feed grades back into Scout",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          }
        },
        {
          "plan": "scout-idea-grading-2026-06-12",
          "archived": false,
          "item": {
            "id": "P-010",
            "text": "Queen prompt-source responsibility (\"grade newly routed Scout ideas 1–5 + one-line critique when triaging\") + `scout:grade-idea` allowlist + tools-md-sync green. Queen grades only ungraded ideas (C-2 makes this structural). (Brief B-06) (B-06 landed: 3 Queen prompt sources D-007 routedRef wording + hive blueprint.yaml scout:grade-idea dep + tools-md-sync byRole fix queen now a valid key; gates 152 green, operator-core suite 11792 green; optional llm-test scenario skipped)",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 3 — Queen auto-grading + UI",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          }
        },
        {
          "plan": "scout-idea-grading-2026-06-12",
          "archived": false,
          "item": {
            "id": "P-006",
            "text": "ScoutView grade controls: 1–5 star control + note popover (open-state in nuqs `?grade=<ideaId>`); optimistic write → invalidate; grade chip with attribution (★4 Queen); owner regrade always allowed. (Brief B-07) (B-07 landed: LearningTab.tsx star control + ?grade= note popover + ★n·Owner/Queen chip, optimistic write via scout/grade-idea proxy; 5 new unit tests 24 green, suite 344; verified live in a dedicated Tauri webview on :3170 — ledger write, owner attribution, note preserved on bare-star regrade)",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 3 — Queen auto-grading + UI",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          }
        },
        {
          "plan": "scout-idea-grading-2026-06-12",
          "archived": false,
          "item": {
            "id": "P-007",
            "text": "Steering visibility: \"how this works\" strip sentence + per-lens weight display from C-1c lensWeights. (Brief B-07) (B-07 landed: Grade step in the Scout how-strip + lens-weight chips with share bars from C-1c lensWeights live: 4 lenses @25% Beta priors rendered)",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 3 — Queen auto-grading + UI",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          }
        },
        {
          "plan": "scout-idea-grading-2026-06-12",
          "archived": false,
          "item": {
            "id": "P-008",
            "text": "E2E: owner grades a real routed idea in the Tauri shell → ledger row correct → `refreshScoutOutcomes` shifts `scout_lens_weights` proportionally (assert delta) → hermetic next-cycle run shows labelled feedback in ideator prompts → Queen auto-grades a fresh idea on her next triage. (Brief B-08) (B-08 su-24cbb: live owner-grade E2E green in Tauri shell Xvfb, :3170 restarted w/ fix — ?grade nuqs popover → ★4+note → ledger row correct, chip survives reload. Weight-delta + real-reader prompt legs pinned in grading-feedback-loop.integration.test.ts 8/8; found+fixed fractional-wins int-cast bug killing lens-weight upserts. Queen live observation awaits her next triage Hive stopped.)",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 4 — Verification (live, owner present)",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          }
        },
        {
          "plan": "scout-idea-grading-2026-06-12",
          "archived": false,
          "item": {
            "id": "P-009",
            "text": "Registry upkeep: gate files in .papercusp/tests.json (VAL-028 scout domain); lint:tests + gen:contract:check + test:affected green. (Brief B-08) (B-08 su-24cbb: 5 gates registered under VAL-028 scout-grading-e2e, scout-grade-write-seam, scout-grader-priming, scout-grade-tool, spa-learning-tab; lint:tests + gen:contract:check + test:affected green; tsc scout-clean +1 baseline excess is the cross-hive lane's flagged in-flight error.)",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 4 — Verification (live, owner present)",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          }
        }
      ]
    },
    {
      "slug": "scout-test-hardening-2026-06-22",
      "ok": true,
      "status": "superseded",
      "archived": false,
      "version": 10,
      "contentHash": "1883be156746621553adcfbb7a9a043126d312e09ae269783565900ba33f0ac0",
      "counts": {
        "items": 0,
        "decisions": 1,
        "sections": 5
      },
      "items": []
    },
    {
      "slug": "scout-timeout-hierarchy-2026-07-13",
      "ok": true,
      "status": "draft",
      "archived": true,
      "version": 26,
      "contentHash": "fa16f6d9b34a0a131fbe6d30df972834da3666573469b12076c6fb0258746834",
      "counts": {
        "items": 3,
        "decisions": 0,
        "sections": 8
      },
      "items": [
        {
          "plan": "scout-timeout-hierarchy-2026-07-13",
          "archived": true,
          "item": {
            "id": "P-001",
            "text": "chat-stream: honor `governorMaxWaitMs` on the anthropic-direct governed path (governedStatelessChat silently drops it today; CLI path honors it). Additive — undefined => current 600s default, zero blast radius.",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 1 — Separate admission from generation",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          }
        },
        {
          "plan": "scout-timeout-hierarchy-2026-07-13",
          "archived": true,
          "item": {
            "id": "P-002",
            "text": "chat-stream: add `onAdmitted?: () => void` to RunAgentChatOptions — fired once the governor admits, immediately before each HTTP attempt (fires per retry attempt). The seam that lets a caller separate queue-wait from generation time.",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 1 — Separate admission from generation",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          }
        },
        {
          "plan": "scout-timeout-hierarchy-2026-07-13",
          "archived": true,
          "item": {
            "id": "P-006",
            "text": "RECURRENCE GUARD: invariant test that an inner budget can never exceed its outer budget; + a scout test that a governor pause LONGER than the ideator cap yields ideas (admission wait honored) or an HONEST capacity error — never a bogus \"timed out\" with $0 spent.",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 1 — Separate admission from generation",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          }
        }
      ]
    },
    {
      "slug": "self-learning-public-release-readiness-2026-07-26",
      "ok": true,
      "status": "superseded",
      "archived": false,
      "version": 40,
      "contentHash": "f18ec0517cfd8c886c40f88574f9f139e1b2956e47bb2e1e4a78170fe9aab605",
      "counts": {
        "items": 12,
        "decisions": 0,
        "sections": 8
      },
      "items": [
        {
          "plan": "self-learning-public-release-readiness-2026-07-26",
          "archived": false,
          "item": {
            "id": "P-004",
            "text": "Reactivate gym for the platform pot: enable the gym:papercusp governor row (existing budget guardrails), kick/await a cycle, verify distinct cyc-N durable rows accumulate and render in the Gym tab on :3170 (per D-002 disclosed assumption).  — note: arm+cycle+render all verified: cyc-46f1579f-c1 settled 04:36Z ($0.42, decision reject); distinct cyc rows accumulate in gym_cycles (WI-5799 fix confirmed); Gym tab (Learning→Gym, pot lens papercusp) renders all 4 distinct cycles + autoloop chip $0.42/$50 — isolated Tauri drive 04:53Z, screenshot on file. Filed EI-18680423618217546 (stale-reclaim threshold 45min &lt; real 52min cycle)",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 1 — stabilize the rails",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-5922",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-5799",
              "state": "done",
              "terminal": true
            },
            {
              "ref": "EI-18680423618217546",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "self-learning-public-release-readiness-2026-07-26",
          "archived": false,
          "item": {
            "id": "P-011",
            "text": "[owner:Avi 2026-07-26 \"where is the ability to disable/enable this in the gui? it should be in the blender tab\"] Blender pane ARMING section: the pane today toggles routine SCHEDULES only (routines:set) — the layer that actually gates gym/learning spend (gym_autoloop_config enable+budget per pot; learning_governor_loops enable+budget per lane) has NO GUI control anywhere (Gym view + Frontier render it read-only). Add an audited bridge tool (gym:arm / governor:arm following the routines:set pattern) + an arming section in the Blender pane showing per-pot gym arm state and per-lane governor arm state with enable/budget controls.  — note: ← WI-5871 done: gym:arm + governor:arm tools + Arming section live-verified (isolated Tauri drive, '13 armed' matches governor data; dryRun previews correct on :3170)",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 1 — stabilize the rails",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-5873",
                "rel": "relates",
                "activity": "free",
                "terminal": true
              },
              {
                "id": "WI-5871",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-5871",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "self-learning-public-release-readiness-2026-07-26",
          "archived": false,
          "item": {
            "id": "P-001",
            "text": "Land the pot-scope tail: gate greens → deploy carries new writers to :3070 → re-run the idempotent gap catch-all (scratchpad/backfill-gap-catchall.sql, session aa65265f) so zero unexplained pot-less learning rows remain. — note: TAIL EXECUTED 06:22Z (deploy-await timed out but sha 33bfb1e6 confirmed ANCESTOR of deployed c624862): gap catch-all re-run idempotent (legs no-op'd; scout_ticks residue = exactly the 32 D-002 drill NULLs) + 3 gap-window fix-survival calibration rows stamped to the platform pot (matching the live writer). ZERO unexplained pot-less rows: remaining NULLs = 4 generic-test tenant + 4 June test-era plan-ship (context-less writers — null CORRECT per D-002). D-001's \"zero unexplained pot-less learning rows\" bar: MET with receipts.",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 1 — stabilize the rails",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-5846",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          }
        },
        {
          "plan": "self-learning-public-release-readiness-2026-07-26",
          "archived": false,
          "item": {
            "id": "P-002",
            "text": "Unstick gate → deploy: after the quiet-cut window, fire release:checkpoint-run; chase residual reds (mem0ai-ollama / @papercusp/web did not reproduce locally); confirm main FFs + :3070 deploys. — note: ← WI-5847 completed (done)",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 1 — stabilize the rails",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-5847",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-5847",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "self-learning-public-release-readiness-2026-07-26",
          "archived": false,
          "item": {
            "id": "P-003",
            "text": "Scout error rate &lt;5%/7d again: measure the post-restart window (scout_ticks economics); if still red, diagnose the 600s ideate-phase timeouts WITH the WI-5784 holder — no double-work. — note: DONE 07-26 10:08Z: post-restart window measured DECISIVE — 0 errors / 9 cycles (scorecard #3 EI-18701161714537378), rejects ~30% baseline p<0.05; ideate-600s class zero recurrence. Literal <5% bound accrues to n>=60 under P-006's standing scorecards.",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 1 — stabilize the rails",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-5866",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-5784",
              "state": "needs-human",
              "terminal": false
            },
            {
              "ref": "EI-18701161714537378",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "self-learning-public-release-readiness-2026-07-26",
          "archived": false,
          "item": {
            "id": "P-005",
            "text": "Frontier lane liveness: every always-on learning lane firing (no stale / should-be-on-but-dark), unmatched governor rows triaged; verify per-pot views via the new pot lens. — note: ← WI-5870 completed (done)",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 1 — stabilize the rails",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-5870",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-5870",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "self-learning-public-release-readiness-2026-07-26",
          "archived": false,
          "item": {
            "id": "P-012",
            "text": "Configurability audit follow-through: sweep every learning-system knob for GUI reachability — lane feature-flag gates (today flippable only in /admin/features; Frontier shows read-only chips — cross-link or embed), scout budget (learning:set-scout-budget has no GUI), and any knob found only in agent tools; file or fix each so the Blender tab is the one-stop owner surface. — note: audit complete: Scout workspace ceiling SHIPPED to Blender pane (catalog scoutCeiling + AutomationPane row → learning:set-scout-budget; 27+54 tests green; live render-verified '$10 ceiling default' in isolated instance, screenshot on file). Residue filed: EI-18682064285629209 (dead-pot gym-config debris), EI-18682077276527199 (native-enforcement fake cap), EI-18682085053402115 (remaining agent-only knobs + flag-chip cross-link). GymDashboard AutoloopTab one-layer write stays WI-5871-deferred (TESTING-parked, unreachable)",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 1 — stabilize the rails",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-5925",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "EI-18682064285629209",
              "state": "open",
              "terminal": false
            },
            {
              "ref": "EI-18682077276527199",
              "state": "open",
              "terminal": false
            },
            {
              "ref": "EI-18682085053402115",
              "state": "open",
              "terminal": false
            },
            {
              "ref": "WI-5871",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "self-learning-public-release-readiness-2026-07-26",
          "archived": false,
          "item": {
            "id": "P-006",
            "text": "Re-certify on the blender-release-readiness rubric: loop wakes emit scorecards (improvements:capture, deterministic evidence — pg counters, tick economics, freshness) and watch rubrics:trend; surface worsening trends unprompted. — note: scorecard #4 @10:08Z (EI-18701239814129379): 6/7 PASS — both drills zero-failure (rubric-seeding + capacity-storm), provenance isolation proven; sole open was generation-parity — RESOLVED in scorecard #5 @19:41Z (EI-18737293363319632): 7/7 PASS, score 10/10; parity now proven by the scoutCodeHash code-identity instrument (b01b01128a38273c on all ticks across host restarts — dev-box staleHost sha-misalignment explicitly superseded as parity evidence). Standing cert continues: scorecard #6 certifies the 21:22:36Z bg-host generation once its post-restart window reaches n≥9 ticks (@23:37Z it is n=5/incomplete; union soak n=18 clean).",
            "storedStatus": "wip",
            "importance": "normal",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 2 — hold the bar (grade mode)",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "wip",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "unclaimed",
            "links": [
              {
                "id": "WI-5894",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": false
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "EI-18701239814129379",
              "state": "done",
              "terminal": true
            },
            {
              "ref": "EI-18737293363319632",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "self-learning-public-release-readiness-2026-07-26",
          "archived": false,
          "item": {
            "id": "P-007",
            "text": "Dark-flag review: DARK_FLAGS_REVIEW_BY expired 2026-07-24 — shrink-only allowlist needs an owner-level pass; I prepare the per-flag list + recommendation, owner decides. — note: resolved by peer WI-5835 (07-26, independently re-verified): full 29-flag review performed, per-flag record in types.ts above DARK_FLAGS_REVIEW_BY, zero graduation candidates, review-by → 2026-08-09, gate green. No owner decision pending — every dark flag stays dark on the merits; owner-authority flips tracked by the standing review cycle, not release-blocking.",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 2 — hold the bar (grade mode)",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "citedWorkItems": [
            {
              "ref": "WI-5835",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "self-learning-public-release-readiness-2026-07-26",
          "archived": false,
          "item": {
            "id": "P-008",
            "text": "Grade pass over routed ideas: grade ungraded su-filed ideas (blender:grade-idea) with typed feedback so low grades wake originators; file gaps as work items. — note: all 13 ungraded su-ideate ideas graded w/ typed feedback (9×4, 4×3; ≤3 grades fired revision wakes — 1 originator woke live, 3 fallback); su-ideate ungraded now 0. No gaps to file: the 606 ungraded-by-human scout rows ALL have outcome+outcome_checked (the automated loop covers them; human_grade is the optional layer)",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 2 — hold the bar (grade mode)",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-5944",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          }
        },
        {
          "plan": "self-learning-public-release-readiness-2026-07-26",
          "archived": false,
          "item": {
            "id": "P-009",
            "text": "Learning tab UX pass for first-run/public users (empty states, lexicon, onboarding) — design-shape work per standing feedback: present the design to Avi before building. — note: LIVE-VERIFIED 08:31Z in isolated headless Tauri: banner (first-run render + ratified copy + lexicon), gloss strap, Open-Arming deep-link (lsb/lst→blender → Blender pane active, screenshot on file), dismiss persists once/workspace across reload. Empties unit-covered (live DB non-empty — correct non-render). WI-6011 closed with evidence.",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 3 — public-release polish (design-shaped: present for review before building)",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-6011",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-6011",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "self-learning-public-release-readiness-2026-07-26",
          "archived": false,
          "item": {
            "id": "P-010",
            "text": "Docs: refresh /internal/docs self-learning overview to the pot-scoped reality; draft the public-facing feature description for owner review. — note: both deliverables done 07-26 ~05:25Z: (1) /internal/docs self-learning overview AUTHORED — apps/operator-docs/src/content/docs/system/self-learning.mdx (no overview existed; new page covers 3 modes + pot-scope invariant + governor/arming + grading rails, drift-anchored; scout-loop.mdx dangling link fixed); (2) public-facing feature description DRAFTED in this plan (section above Decisions). Awaiting owner review of the draft copy.",
            "storedStatus": "needs-human",
            "importance": "normal",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 3 — public-release polish (design-shaped: present for review before building)",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "needs-human",
            "unresolvedBlockers": [],
            "needsHuman": true,
            "staleBlockedHint": null
          }
        }
      ]
    },
    {
      "slug": "dream-performance-grading-papercusp-2026-10-07",
      "ok": true,
      "status": "draft",
      "archived": false,
      "version": 23,
      "contentHash": "925864c378f8a439be6b1ca2cd707b5b810b0f2d51c010933c50771d400dbb76",
      "counts": {
        "items": 3,
        "decisions": 9,
        "sections": 6
      },
      "items": [
        {
          "plan": "dream-performance-grading-papercusp-2026-10-07",
          "archived": false,
          "item": {
            "id": "P-001",
            "text": "Verify papercusp-only effective Dream enablement and close the owned enablement repair with guard evidence; reuse WI-10007335.",
            "storedStatus": "todo",
            "importance": "normal",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 1",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "todo",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "held-stalled",
            "links": [
              {
                "id": "WI-6554700010014250",
                "rel": "plan_item_stamp",
                "activity": "stalled",
                "terminal": false
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-10007335",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "dream-performance-grading-papercusp-2026-10-07",
          "archived": false,
          "item": {
            "id": "P-002",
            "text": "Create and independently ratify the missing recurring Dream performance rubric, reusing existing outcome semantics and instruments.",
            "storedStatus": "todo",
            "importance": "normal",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 1",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "todo",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "held-stalled",
            "links": [
              {
                "id": "WI-6554700010014271",
                "rel": "plan_item_stamp",
                "activity": "stalled",
                "terminal": false
              }
            ]
          }
        },
        {
          "plan": "dream-performance-grading-papercusp-2026-10-07",
          "archived": false,
          "item": {
            "id": "P-003",
            "text": "Emit the initial scorecard and run bounded grade-and-correct iterations with source/version/usage evidence.  — note: ← WI-6554700010016592 blocked (1 external blocker)",
            "storedStatus": "blocked",
            "importance": "normal",
            "blockedBy": [
              "P-001",
              "P-002"
            ],
            "decisionRefs": [],
            "phase": "Phase 1",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "blocked",
            "unresolvedBlockers": [
              "P-001",
              "P-002"
            ],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "unclaimed",
            "links": [
              {
                "id": "WI-6554700010016592",
                "rel": "relates",
                "activity": "free",
                "terminal": false,
                "blocked": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-6554700010016592",
              "state": "blocked",
              "terminal": false
            }
          ]
        }
      ]
    },
    {
      "slug": "self-learning-dreaming-verified-shipment-2026-10-03",
      "ok": true,
      "status": "draft",
      "archived": false,
      "version": 11,
      "contentHash": "defc35112f3438cee0b07fb0804dedbcda43655423ebb0a0cb22adc1c82b946a",
      "counts": {
        "items": 4,
        "decisions": 3,
        "sections": 9
      },
      "items": [
        {
          "plan": "self-learning-dreaming-verified-shipment-2026-10-03",
          "archived": false,
          "item": {
            "id": "P-001",
            "text": "Publish WI-10005786 evidence-backed audit verdict; complete the scoped program lifecycle, remaining acceptance work, governing decision and current owner census. Exclude rubric templates from delivery totals and preserve historical/recurring meaning.",
            "storedStatus": "todo",
            "importance": "high",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 1 — Verified program completion",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "todo",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "citedWorkItems": [
            {
              "ref": "WI-10005786",
              "state": "open",
              "terminal": false
            }
          ]
        },
        {
          "plan": "self-learning-dreaming-verified-shipment-2026-10-03",
          "archived": false,
          "item": {
            "id": "P-002",
            "text": "Resolve confirmed production efficacy gaps under existing ledgers and controls: starvation-proof Scout capped-lens rotation, effective Dream/Gym activation against approved owner direction, feedback/outcome and resilience/retention defects. Register individual fixes and conventional recurrence tests; coordinate existing owned issues.",
            "storedStatus": "todo",
            "importance": "high",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 1 — Verified program completion",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "todo",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          }
        },
        {
          "plan": "self-learning-dreaming-verified-shipment-2026-10-03",
          "archived": false,
          "item": {
            "id": "P-003",
            "text": "Drive remaining existing self-learning, Blender, Gym and Dream plan items through their governing decisions and original acceptance bars. Coordinate live owners rather than duplicating claims; execute independent steps without waiting on final promotion.",
            "storedStatus": "todo",
            "importance": "high",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 1 — Verified program completion",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "todo",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          }
        },
        {
          "plan": "self-learning-dreaming-verified-shipment-2026-10-03",
          "archived": false,
          "item": {
            "id": "P-004",
            "text": "Verify final program acceptance and exact promoted/deployed artifact shipment, with accountable residue and correct historical/superseded/recurring dispositions. Do not mark live deliverables shipped from source tests or intent alone.",
            "storedStatus": "todo",
            "importance": "high",
            "blockedBy": [
              "P-001",
              "P-002",
              "P-003"
            ],
            "decisionRefs": [],
            "phase": "Phase 1 — Verified program completion",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "blocked",
            "unresolvedBlockers": [
              "P-001",
              "P-002",
              "P-003"
            ],
            "needsHuman": false,
            "staleBlockedHint": null
          }
        }
      ]
    },
    {
      "slug": "native-code-intelligence-ecosystem-and-dream-2026-10-09",
      "ok": true,
      "status": "ready",
      "archived": false,
      "version": 117,
      "contentHash": "b16a8bf6cc2b8d4a67838d15b9769be611317f7695d21233095f1fed32837ae7",
      "counts": {
        "items": 42,
        "decisions": 23,
        "sections": 23
      },
      "items": [
        {
          "plan": "native-code-intelligence-ecosystem-and-dream-2026-10-09",
          "archived": false,
          "item": {
            "id": "P-001",
            "text": "Reconcile the current source, prior decisions and owned follow-ups. Read gitnexus-deterministic-integration D-004/D-005/D-026 plus P-012/P-018, WI-10006543 and WI-10006809. Resolve the known cost-label correction through WI-10007660 rather than duplicate it. Inventory GitNexus-backed operations, licences/telemetry, runtime loaded paths and test coverage. Output a source-pinned baseline and distribution/internal-use decision register.  — note: ← WI-10007864 completed (done)",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 0 — Baseline and decision gates",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-10007864",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-10006543",
              "state": "blocked",
              "terminal": false
            },
            {
              "ref": "WI-10006809",
              "state": "done",
              "terminal": true
            },
            {
              "ref": "WI-10007660",
              "state": "done",
              "terminal": true
            },
            {
              "ref": "WI-10007864",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "native-code-intelligence-ecosystem-and-dream-2026-10-09",
          "archived": false,
          "item": {
            "id": "P-002",
            "text": "Preregister a fair evaluation in the existing comparison harness: matched operation sets, frozen corpora, per-language correctness, false-empty cases, setup/query latency, peak/resident memory, disk footprint, source freshness and real agent tasks. Freeze budgets and acceptance thresholds before results. Include configured-vs-unconfigured language and stale/deleted-source controls; record failed or unmeasurable arms.   — note: ← WI-10007865 completed (done)",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [
              "P-001"
            ],
            "decisionRefs": [],
            "phase": "Phase 0 — Baseline and decision gates",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-10007865",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-10007865",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "native-code-intelligence-ecosystem-and-dream-2026-10-09",
          "archived": false,
          "item": {
            "id": "P-003",
            "text": "Extend the existing CodeIntelAnswer contract with source/graph scope, versioned symbol identity, edge provenance, content hashes, language capability and observed/inferred/unknown relationships. Reuse graph:query, lsp:query, code:pack, testing domains and repository registries. Preserve explicit truncation, degraded/unsupported states and current-source corroboration. Document identity/remapping across edits without inventing certainty.   — note: ← WI-10007866 completed (done)",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [
              "P-001"
            ],
            "decisionRefs": [],
            "phase": "Phase 1 — Shared evidence and multilingual foundations",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-10007866",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-10007866",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "native-code-intelligence-ecosystem-and-dream-2026-10-09",
          "archived": false,
          "item": {
            "id": "P-004",
            "text": "Add compiler-backed graph adapters through the existing language-spec/capability registry. Reuse pinned language servers or SCIP indexers, validating supported intents and build prerequisites per language. Proposed first cohort: JS/TS, Rust, Python and Go; C/C++, Java and other ecosystems are separately admitted by priority. Existing Rust LSP navigation does not certify Rust graph parity. Unsupported intents return unknown/redirects.   — note: ← WI-10007867 completed (done)",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [
              "P-002",
              "P-003"
            ],
            "decisionRefs": [],
            "phase": "Phase 1 — Shared evidence and multilingual foundations",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-10007867",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-10007867",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "native-code-intelligence-ecosystem-and-dream-2026-10-09",
          "archived": false,
          "item": {
            "id": "P-006",
            "text": "Introduce bounded shared caches through the current managed language-service/process lifecycle. Borrow CodeGraph's per-file pending warnings, debounced refresh and reconnect hash reconciliation. Invalidate source, aliases, manifests, compiler options and deletes; account for submodules and concurrent edits. Test missed events/restarts, scope isolation and long-lived resource behavior against the uncached path.   — note: ← WI-10007869 completed (done)",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [
              "P-002",
              "P-003"
            ],
            "decisionRefs": [],
            "phase": "Phase 1 — Shared evidence and multilingual foundations",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-10007869",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-10007869",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "native-code-intelligence-ecosystem-and-dream-2026-10-09",
          "archived": false,
          "item": {
            "id": "P-007",
            "text": "Complete first-party symbol/context/callees operations behind graph:query. Consolidate calls, imports, inheritance, implementations, members, field reads/writes and overrides when supported, with exact source sites and disambiguation. Reuse LSP operations already present rather than duplicate references, diagnostics or rename previews. Certify the exposed operation, not only its benchmark adapter.   — note: ← WI-10007870 completed (done)",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [
              "P-003",
              "P-004",
              "P-006"
            ],
            "decisionRefs": [],
            "phase": "Phase 2 — Complete precise graph operations",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-10007870",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-10007870",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "native-code-intelligence-ecosystem-and-dream-2026-10-09",
          "archived": false,
          "item": {
            "id": "P-008",
            "text": "Add first-party impact and directed trace with depth/path limits and per-hop provenance. Borrow GitNexus's context-to-impact-to-trace workflow. Distinguish static possible paths from observed runtime execution; label indirect/dynamic/uncertain edges and truncation. Tests must include cycles, homonyms, re-exports, callback edges and a nonexistent target control.   — note: ← WI-10007871 completed (done)",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [
              "P-007"
            ],
            "decisionRefs": [],
            "phase": "Phase 2 — Complete precise graph operations",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-10007871",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-10007871",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "native-code-intelligence-ecosystem-and-dream-2026-10-09",
          "archived": false,
          "item": {
            "id": "P-009",
            "text": "Complete the first-party import-snapshot handover using the existing snapshot schema/producer and owned WI-10006809 evidence. Compare live cross-workspace edges and rejected resolutions, exercise selector corroboration, and coordinate the existing P-012/P-018 decision lane. Switch the selector's regular refresh only after equivalent-or-better validated selection behavior; preserve a reversible producer choice.   — note: ← WI-10007872 completed (done)",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [
              "P-002",
              "P-003",
              "P-006"
            ],
            "decisionRefs": [],
            "phase": "Phase 2 — Complete precise graph operations",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-10007872",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-10006809",
              "state": "done",
              "terminal": true
            },
            {
              "ref": "WI-10007872",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "native-code-intelligence-ecosystem-and-dream-2026-10-09",
          "archived": false,
          "item": {
            "id": "P-010",
            "text": "Build the native explain-this-change report through existing graph/pack/diff surfaces: changed behaviors and symbols, affected contracts/consumers, relevant tests, documentation/evidence needing recheck, work ownership and runtime provenance. Trigger bounded pre-edit/pre-review briefs with freshness checks. Every proposed consequence cites its path or admits uncertainty.   — note: ← WI-10007873 completed (done)",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [
              "P-007",
              "P-008"
            ],
            "decisionRefs": [],
            "phase": "Phase 3 — Integrate planning, editing and verification",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-10007873",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-10007873",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "native-code-intelligence-ecosystem-and-dream-2026-10-09",
          "archived": false,
          "item": {
            "id": "P-011",
            "text": "Extend affected-test selection and behavioral-strand checks with validated graph paths and per-symbol static test reach/test-gap suggestions. Maintain the add-only baseline and offline snapshot consumption; graph failure never silently narrows tests or creates a live-server dependency for ordinary gate runs. Running tests remains authoritative; static test reach is not execution coverage.   — note: ← WI-10007874 completed (done)",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [
              "P-008",
              "P-009",
              "P-010"
            ],
            "decisionRefs": [],
            "phase": "Phase 3 — Integrate planning, editing and verification",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-10007874",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-10007874",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "native-code-intelligence-ecosystem-and-dream-2026-10-09",
          "archived": false,
          "item": {
            "id": "P-014",
            "text": "Connect API/tool registry entries to implementations, request/response validators, callers and contract documentation. Borrow GitNexus tool_map/route_map/shape_check/api_impact. Identify response-field/interface changes and affected consumers; validate behavior through typed/runtime contract tests. Dynamic registrations remain explicit unknowns instead of fabricated registry completeness.   — note: ← WI-10007877 completed (done)",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [
              "P-003",
              "P-007",
              "P-010"
            ],
            "decisionRefs": [],
            "phase": "Phase 3 — Integrate planning, editing and verification",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-10007877",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-10007877",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "native-code-intelligence-ecosystem-and-dream-2026-10-09",
          "archived": false,
          "item": {
            "id": "P-015",
            "text": "Extend existing spec-evidence/source/test fingerprints with dependent code relationship evidence so edits identify requirements and prior acceptance results needing re-verification. Integrate with spec-driven-tooling-integration rather than duplicate it. Keep immutable requirement revisions and recorded test-run identity; never auto-revalidate a passing claim from a graph edge.   — note: ← WI-10007878 completed (done)",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [
              "P-003",
              "P-008"
            ],
            "decisionRefs": [],
            "phase": "Phase 3 — Integrate planning, editing and verification",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-10007878",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-10007878",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "native-code-intelligence-ecosystem-and-dream-2026-10-09",
          "archived": false,
          "item": {
            "id": "P-017",
            "text": "Join current-build source graphs to existing pipeline-position and serving-runtime records. Show which repository/content version an answer describes and whether relevant source is loaded on the selected staging or background runtime. Distinguish edited source from loaded artifacts. Verify this implementation on current-build runtimes; P-027 separately owns exact final shipment verification.   — note: ← WI-10007880 completed (done)",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [
              "P-003",
              "P-006"
            ],
            "decisionRefs": [],
            "phase": "Phase 3 — Integrate planning, editing and verification",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-10007880",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-10007880",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "native-code-intelligence-ecosystem-and-dream-2026-10-09",
          "archived": false,
          "item": {
            "id": "P-026",
            "text": "Execute the preregistered multilingual and agent-journey acceptance matrix against the actual exposed native tools. Verify matched correctness, false empties, stale-source handling, memory/disk/query cost, cache invalidation, source exclusions, interface/test/documentation/evidence workflows and isolation. Bind source/spec/test fingerprints in the project's normal suites and independent acceptance process; disclose all untested language/intent cells.   — note: ← WI-10007889 released",
            "storedStatus": "todo",
            "importance": "high",
            "blockedBy": [
              "P-002",
              "P-004",
              "P-005",
              "P-006",
              "P-008",
              "P-011",
              "P-012",
              "P-013",
              "P-014",
              "P-015",
              "P-016",
              "P-017",
              "P-018",
              "P-019",
              "P-020",
              "P-021",
              "P-035",
              "P-036",
              "P-037",
              "P-038",
              "P-039",
              "P-040",
              "P-041"
            ],
            "decisionRefs": [],
            "phase": "Phase 6 — Acceptance, deployment and GitNexus disposition",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "blocked",
            "unresolvedBlockers": [
              "P-040",
              "P-041"
            ],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "unclaimed",
            "links": [
              {
                "id": "WI-10007889",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": false
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-10007889",
              "state": "open",
              "terminal": false
            }
          ]
        },
        {
          "plan": "native-code-intelligence-ecosystem-and-dream-2026-10-09",
          "archived": false,
          "item": {
            "id": "P-027",
            "text": "Coordinate the existing GitNexus P-012/P-018 keep/narrow/scale-back ruling with this acceptance evidence. Inventory remaining consumers, secure the licence route for retained use, and migrate or explicitly retain each dependency. Only then stop unnecessary reindex/index services and reclaim resources through an approved reversible rollout. Verify distribution exclusions, current-build behavior and exact shipped artifact; never force past a red gate or duplicate its live fixer.",
            "storedStatus": "todo",
            "importance": "high",
            "blockedBy": [
              "P-001",
              "P-009",
              "P-017",
              "P-026",
              "P-042"
            ],
            "decisionRefs": [],
            "phase": "Phase 6 — Acceptance, deployment and GitNexus disposition",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "blocked",
            "unresolvedBlockers": [
              "P-026",
              "P-042"
            ],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "unclaimed",
            "links": [
              {
                "id": "WI-10007890",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": false,
                "blocked": true
              }
            ]
          }
        },
        {
          "plan": "native-code-intelligence-ecosystem-and-dream-2026-10-09",
          "archived": false,
          "item": {
            "id": "P-033",
            "text": "Measure native code-intelligence use and drive it to good use [owner:Avi 2026-10-14, directive #1853]. Build one reusable adoption instrument over the deployed invocation ledger plus the native-command activity record: per operation (graph:query ops, lsp:query, code:pack, explain-change, task briefs) call volume, distinct agents and roles, empty/error/stale/refusal rates, latency, whether a returned site is then read or edited, and raw text-search or direct GitNexus lookups that a native operation would have answered. Freeze a baseline window and an adoption target before any intervention. Close gaps only through existing surfaces: tool guidance, the bash-to-tool routing pairs, playbook routing, and default enrichment in claims/briefs. Bind the instrument to a rubric check, schedule a recurring rubric re-score with a criterion-regression watch, and report each window against the target, negative results included.  — note: ← WI-6554700010012122 released",
            "storedStatus": "todo",
            "importance": "high",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 6 — Acceptance, deployment and GitNexus disposition",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "todo",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "full",
            "workers": [
              "su-8b8dac44-8614-451c-9726-3dc0228248b2"
            ],
            "holder": {
              "ownerId": "su-8b8dac44-8614-451c-9726-3dc0228248b2",
              "ownerLabel": "su · su-8b8da",
              "goalText": "Native-plan author repair complete: R30-R34 active with preserved proof; continue parent WI-6554700010012117 and P033/P041 exact-plane evidence, preserve pending scope questions/windows; EI26248236265625483 fixed locally",
              "declaredAt": "2026-10-17 13:38:37.425648-04",
              "stale": false
            },
            "links": [
              {
                "id": "WI-6554700010012122",
                "rel": "plan_item_stamp",
                "activity": "progressing",
                "terminal": false
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-6554700010012122",
              "state": "open",
              "terminal": false
            }
          ]
        },
        {
          "plan": "native-code-intelligence-ecosystem-and-dream-2026-10-09",
          "archived": false,
          "item": {
            "id": "P-034",
            "text": "Shared push channel. Add one code-intelligence leg to the existing PostToolBatch mid-turn context injector (the hook that already pushes memory) rather than a new hook family. It owns a per-turn budget (about 1,500 chars, sharing the memory budget), per-session dedupe so the same fact is never pushed twice, a snapshot-SHA freshness stamp on every push, a default-ON flag per leg, and push telemetry (leg, subject, delivered) that P-041 reads. Reads only the precomputed first-party snapshot; never starts or waits on a cold LSP.  — note: ← WI-6554700010015055 completed (done)",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 3b — Proactive delivery (D-016)",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-6554700010015055",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-6554700010015055",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "native-code-intelligence-ecosystem-and-dream-2026-10-09",
          "archived": false,
          "item": {
            "id": "P-035",
            "text": "Grep answer-in-place. When a shell grep/rg is a definition or call-site lookup for a symbol the first-party snapshot resolves, let the command run and push the native answer: definition site, caller count per workspace, top callers, and what grep missed (re-exports, aliases) or falsely matched (comments, strings). Replaces the advisory-only code-search routing pair, which was followed 1 time in 138 fires (WI-10006282). Unresolved symbols push nothing.   — note: ← WI-6554700010015142 completed (done)",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [
              "P-034"
            ],
            "decisionRefs": [],
            "phase": "Phase 3b — Proactive delivery (D-016)",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-6554700010015142",
                "rel": "relates",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-10006282",
              "state": "done",
              "terminal": true
            },
            {
              "ref": "WI-6554700010015142",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "native-code-intelligence-ecosystem-and-dream-2026-10-09",
          "archived": false,
          "item": {
            "id": "P-036",
            "text": "First-touch pre-edit brief. On the first Read or Edit of a source file in a session, push the P-010 pre-edit brief: exported symbols and their consumer counts (cross-workspace consumers called out), tests that statically reach them, anchored docs (P-016), spec requirements whose evidence depends on them (P-015), and live locks/claims on consumer files (P-013). Cite paths; say unknown where the graph is blind.   — note: ← WI-6554700010015197 completed (done)",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [
              "P-034"
            ],
            "decisionRefs": [],
            "phase": "Phase 3b — Proactive delivery (D-016)",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-6554700010015197",
                "rel": "relates",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-6554700010015197",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "native-code-intelligence-ecosystem-and-dream-2026-10-09",
          "archived": false,
          "item": {
            "id": "P-037",
            "text": "Interface-edit consequence note. After an Edit changes an exported signature, returned field or registered tool shape, push the affected consumers and the exact testing:run { files } call for tests that reach them. Merge with the existing required-field and behavioural strand nudges so the agent gets one note, not three.   — note: ← WI-6554700010015384 completed (done)",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [
              "P-034"
            ],
            "decisionRefs": [],
            "phase": "Phase 3b — Proactive delivery (D-016)",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-6554700010015384",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-6554700010015384",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "native-code-intelligence-ecosystem-and-dream-2026-10-09",
          "archived": false,
          "item": {
            "id": "P-038",
            "text": "Failing-test incident push. When testing:run or test:file reports failing files, attach the P-018 incident brief: recently changed symbols on the failing test's static reach, the work items that changed them, and open items on them. Graph paths prioritise hypotheses only; the observed failure stays authoritative.   — note: ← WI-6554700010015561 completed (done)",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [
              "P-034"
            ],
            "decisionRefs": [],
            "phase": "Phase 3b — Proactive delivery (D-016)",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-6554700010015561",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-6554700010015561",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "native-code-intelligence-ecosystem-and-dream-2026-10-09",
          "archived": false,
          "item": {
            "id": "P-039",
            "text": "Completion and intent briefs. (a) On work_items:complete, build explain-this-change (pre-review phase) from the completion's filesChanged and attach it, flagging tests that reach changed symbols but were not run. (b) On coord:declare-intent / coord:orient without a claim, deliver the same bounded task brief claims get, keyed on intent text and declared files.   — note: ← WI-6554700010016164 completed (done)",
            "storedStatus": "done",
            "importance": "high",
            "blockedBy": [
              "P-034"
            ],
            "decisionRefs": [],
            "phase": "Phase 3b — Proactive delivery (D-016)",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-6554700010016164",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-6554700010016164",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "native-code-intelligence-ecosystem-and-dream-2026-10-09",
          "archived": false,
          "item": {
            "id": "P-040",
            "text": "Speed and refusals. Serve definition and caller lookups from the first-party snapshot so p50 is under 1 s, keeping the LSP daemon warm only for intents that need the compiler. Ship and verify on the deployed operator the judge-role read-only code-intelligence access (all 28 baseline refusals were the judge role).",
            "storedStatus": "todo",
            "importance": "high",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 3b — Proactive delivery (D-016)",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "todo",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "held-stalled",
            "links": [
              {
                "id": "WI-6554700010015276",
                "rel": "plan_item_stamp",
                "activity": "stalled",
                "terminal": false
              }
            ]
          }
        },
        {
          "plan": "native-code-intelligence-ecosystem-and-dream-2026-10-09",
          "archived": false,
          "item": {
            "id": "P-041",
            "text": "Push-outcome measurement. Extend the native-adoption instrument with per-leg delivered, acted-on (agent read/edited a cited site or ran the suggested tests within the turn window) and grep-after-push (agent grepped the same symbol anyway) rates, bound as NEW rubric criteria. D-011's baseline, bounds and target stay unchanged. A leg whose acted-on rate stays low is tuned or switched off by recorded decision.",
            "storedStatus": "todo",
            "importance": "high",
            "blockedBy": [
              "P-034"
            ],
            "decisionRefs": [],
            "phase": "Phase 3b — Proactive delivery (D-016)",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "todo",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "partial",
            "workers": [
              "su-8b8dac44-8614-451c-9726-3dc0228248b2"
            ],
            "holder": {
              "ownerId": "su-8b8dac44-8614-451c-9726-3dc0228248b2",
              "ownerLabel": "su · su-8b8da",
              "goalText": "Native-plan author repair complete: R30-R34 active with preserved proof; continue parent WI-6554700010012117 and P033/P041 exact-plane evidence, preserve pending scope questions/windows; EI26248236265625483 fixed locally",
              "declaredAt": "2026-10-17 13:38:37.96663-04",
              "stale": false
            },
            "links": [
              {
                "id": "WI-6554700010016419",
                "rel": "relates",
                "activity": "stalled",
                "terminal": false
              }
            ]
          }
        },
        {
          "plan": "native-code-intelligence-ecosystem-and-dream-2026-10-09",
          "archived": false,
          "item": {
            "id": "P-042",
            "text": "GitNexus decision now. Inventory every remaining GitNexus consumer (tools, routines incl. the hourly gitnexus-reindex, scripts, docs, test selection) with measured use, absorb gitnexus-deterministic-integration-2026-10-05 P-012 (keep/narrow/scale back) and P-018 (deployed check), and record a keep/narrow/retire disposition per consumer with the licence route for anything retained. P-027 then keeps only the final acceptance coordination.",
            "storedStatus": "todo",
            "importance": "high",
            "blockedBy": [],
            "decisionRefs": [],
            "phase": "Phase 3b — Proactive delivery (D-016)",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "todo",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "unclaimed",
            "links": [
              {
                "id": "WI-6554700010015356",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": false
              }
            ]
          }
        },
        {
          "plan": "native-code-intelligence-ecosystem-and-dream-2026-10-09",
          "archived": false,
          "item": {
            "id": "P-005",
            "text": "Add broader syntax indexing through maintained parsers where compiler evidence is unavailable, borrowing Tree-sitter-based designs from CodeGraph/Codebase-Memory. Emit language-aware declarations/imports/inheritance and clearly labelled inferred edges. Verify grammar and licence support before admission. Do not equate parser availability with complete call resolution; record excluded/generated/dynamic source.   — note: ← WI-10007868 completed (done)",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [
              "P-002",
              "P-003"
            ],
            "decisionRefs": [],
            "phase": "Phase 1 — Shared evidence and multilingual foundations",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-10007868",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-10007868",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "native-code-intelligence-ecosystem-and-dream-2026-10-09",
          "archived": false,
          "item": {
            "id": "P-012",
            "text": "Extend work-item claim/checkpoint enrichment with a bounded task brief: relevant implementations, call paths, consumers, governing decisions, source-linked docs and tests. Reuse code:pack and canonical work-item/plan readers. Scope context to the repository and task; update stale snippets on resume and record exclusions rather than flood the agent context.   — note: ← WI-10007875 completed (done)",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [
              "P-003",
              "P-007",
              "P-010"
            ],
            "decisionRefs": [],
            "phase": "Phase 3 — Integrate planning, editing and verification",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-10007875",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-10007875",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "native-code-intelligence-ecosystem-and-dream-2026-10-09",
          "archived": false,
          "item": {
            "id": "P-013",
            "text": "Add graph-assisted decomposition and overlap advisories to existing planning/coordination flows. Surface shared interfaces, dependency order, file claims and responsible work items for safe parallel execution. Query live claims for ownership; graph similarity cannot take over assignments, bypass locks or mandate fan-out. Prove ordering advice on representative task dependency fixtures.   — note: ← WI-10007876 completed (done)",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [
              "P-003",
              "P-008",
              "P-012"
            ],
            "decisionRefs": [],
            "phase": "Phase 3 — Integrate planning, editing and verification",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-10007876",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-10007876",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "native-code-intelligence-ecosystem-and-dream-2026-10-09",
          "archived": false,
          "item": {
            "id": "P-016",
            "text": "Supply code/symbol/interface change evidence to the existing documentation anchors and steward. Detect missing/renamed symbols and changed documented workflows; produce scoped doc-update candidates with source provenance. Use docs:author for canonical documentation, preserving decisions/history and review gates rather than rewriting generated projections.   — note: ← WI-10007879 completed (done)",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [
              "P-003",
              "P-010",
              "P-014"
            ],
            "decisionRefs": [],
            "phase": "Phase 3 — Integrate planning, editing and verification",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-10007879",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-10007879",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "native-code-intelligence-ecosystem-and-dream-2026-10-09",
          "archived": false,
          "item": {
            "id": "P-018",
            "text": "Add incident investigation briefs linking failed tests/errors to candidate code paths, recent changes and responsible work records. Join existing logs/test ledgers and runtime provenance. Graph paths prioritize hypotheses; require observed runtime/test evidence to establish a cause. Keep read-only diagnosis separate from live-gate control and preserve single live-gate ownership.   — note: ← WI-10007881 completed (done)",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [
              "P-008",
              "P-012",
              "P-017"
            ],
            "decisionRefs": [],
            "phase": "Phase 3 — Integrate planning, editing and verification",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-10007881",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-10007881",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "native-code-intelligence-ecosystem-and-dream-2026-10-09",
          "archived": false,
          "item": {
            "id": "P-019",
            "text": "Add scoped HTTP/RPC/API and event producer-consumer relationships across registered repositories/pots. Borrow GitNexus contract groups and Codebase-Memory HTTP_CALLS/EMITS/LISTENS_ON patterns. Track route/handler/client fields, tool invocations, middleware and service-boundary provenance; preserve workspace/auth scope and label dynamic names/ambiguous contracts. Coordinate participating repositories without a new management plane.   — note: ← WI-10007882 completed (done)",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [
              "P-003",
              "P-005",
              "P-008",
              "P-014",
              "P-017"
            ],
            "decisionRefs": [],
            "phase": "Phase 4 — Framework and cross-repository relationships",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-10007882",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-10007882",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "native-code-intelligence-ecosystem-and-dream-2026-10-09",
          "archived": false,
          "item": {
            "id": "P-020",
            "text": "Add functional communities, inferred entry-point flows and graph-specific concept search. Borrow GitNexus process-grouped hybrid retrieval while extending existing search/ranking primitives. Keep architecture clusters and semantic similarity as discovery suggestions; validate against current source and independent relevance cases, including nonsense queries and disconnected code.   — note: ← WI-10007883 completed (done)",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [
              "P-002",
              "P-008",
              "P-019"
            ],
            "decisionRefs": [],
            "phase": "Phase 4 — Framework and cross-repository relationships",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-10007883",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-10007883",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "native-code-intelligence-ecosystem-and-dream-2026-10-09",
          "archived": false,
          "item": {
            "id": "P-021",
            "text": "Return compact symbol/path/source evidence bundles through code:pack and current result budgets. Include stable references, exact source excerpts, edge provenance, coverage and an expansion route; distinguish code already inspected from inferred architecture. Measure both tokens processed and retrieval context retained, borrowing CodeGraph's source-plus-path design without its unbounded payloads.   — note: ← WI-10007884 completed (done)",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [
              "P-003",
              "P-007",
              "P-008"
            ],
            "decisionRefs": [],
            "phase": "Phase 4 — Framework and cross-repository relationships",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-10007884",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-10007884",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "native-code-intelligence-ecosystem-and-dream-2026-10-09",
          "archived": false,
          "item": {
            "id": "P-022",
            "text": "Enrich the existing partial Dream capability catalog and source/test packets with graph-discovered candidate boundaries and implementation relationships. A function/cluster is not automatically a capability: validate purpose, mechanism, inputs/outputs, failure contracts and test evidence against current source. Reuse manifest/packet schemas, source hashes and testing-domain identities; record unmapped scope.   — note: ← WI-10007885 completed (done)",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [
              "P-003",
              "P-007",
              "P-008",
              "P-021"
            ],
            "decisionRefs": [],
            "phase": "Phase 5 — Enrich the existing Dream pipeline",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-10007885",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-10007885",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "native-code-intelligence-ecosystem-and-dream-2026-10-09",
          "archived": false,
          "item": {
            "id": "P-023",
            "text": "Populate the existing Dream sampler relation/third-role inputs with version-bound producer-consumer, transferable-invariant, purpose-mechanism and complementary-lifecycle candidates. Use APIs/events where admitted. Retain broad cross-domain sampling and random controls; exclude aliases/overlaps and respect resource/auth prerequisites. Existing connectivity must not become a requirement for exploring new combinations.   — note: ← WI-10007886 completed (done)",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [
              "P-022"
            ],
            "decisionRefs": [],
            "phase": "Phase 5 — Enrich the existing Dream pipeline",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-10007886",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-10007886",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "native-code-intelligence-ecosystem-and-dream-2026-10-09",
          "archived": false,
          "item": {
            "id": "P-024",
            "text": "Extend independent Dream review/prior-art retrieval with source and graph candidates beyond the initial catalog. Check whether the proposed integration already exists, whether scope/order/failure contracts permit it, and what falsifying experiment proves benefit. No edge found is not proof of novelty or absence. Preserve proposal-only generation, source revalidation, governor/cost controls and Blender's existing implementation authority.   — note: ← WI-10007887 completed (done)",
            "storedStatus": "done",
            "importance": "normal",
            "blockedBy": [
              "P-008",
              "P-022",
              "P-023"
            ],
            "decisionRefs": [],
            "phase": "Phase 5 — Enrich the existing Dream pipeline",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "done",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-10007887",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-10007887",
              "state": "done",
              "terminal": true
            }
          ]
        },
        {
          "plan": "native-code-intelligence-ecosystem-and-dream-2026-10-09",
          "archived": false,
          "item": {
            "id": "P-025",
            "text": "Run a preregistered matched evaluation of graph-enriched Dream against the current sampler/reviewer using frozen populations, equal budgets and independent grading. Reuse Dream run/experiment/outcome ledgers. Measure duplicate/refinement rates, validated useful connections, downstream implemented outcomes and usefulness per dollar with unknown usage explicit. Report negative/inconclusive results and choose retain/narrow/drop from evidence.   — note: ← WI-10007888 released",
            "storedStatus": "todo",
            "importance": "normal",
            "blockedBy": [
              "P-002",
              "P-022",
              "P-023",
              "P-024"
            ],
            "decisionRefs": [],
            "phase": "Phase 5 — Enrich the existing Dream pipeline",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "todo",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": null
          },
          "coverage": {
            "level": "held-stalled",
            "links": [
              {
                "id": "WI-10007888",
                "rel": "plan_item_stamp",
                "activity": "stalled",
                "terminal": false
              }
            ]
          },
          "citedWorkItems": [
            {
              "ref": "WI-10007888",
              "state": "open",
              "terminal": false
            }
          ]
        },
        {
          "plan": "native-code-intelligence-ecosystem-and-dream-2026-10-09",
          "archived": false,
          "item": {
            "id": "P-028",
            "text": "Evaluate a graph visualization in the existing product UI after reliable edge/evidence APIs exist. Include scope/freshness, uncertainty and links to code/work/spec/test records. Owner selects whether it joins the initial release; no new app scaffold or independent graph service.   — note: Moved by D-016 [owner:Avi 2026-10-15] to native-code-intelligence-optional-evaluations-2026-10-15 (P-028→P-001, P-029→P-002, P-030→P-003, P-031→P-004, P-032→P-005). Not abandoned: optional evaluations now follow the core plan.",
            "storedStatus": "dropped",
            "importance": "low",
            "blockedBy": [
              "P-020",
              "P-021",
              "P-026"
            ],
            "decisionRefs": [],
            "phase": "Phase 7 — Captured optional roadmap",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "dropped",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": "stored status is 'dropped' but blocked-by dependency (P-026) has not resolved — effectiveStatus is 'dropped' because a completed item cannot be blocked. The edge is likely stale, or was only partly required (the dependent finished against a partial result). Drop or repoint the blocked-by edge with plans:set-content if it no longer holds; if the dependency really was required in full, this item may have been closed early."
          },
          "coverage": {
            "level": "held-stalled",
            "links": [
              {
                "id": "WI-10007891",
                "rel": "plan_item_stamp",
                "activity": "stalled",
                "terminal": false
              }
            ]
          }
        },
        {
          "plan": "native-code-intelligence-ecosystem-and-dream-2026-10-09",
          "archived": false,
          "item": {
            "id": "P-029",
            "text": "Evaluate graph-assisted architecture/wiki generation through canonical docs authorship. Generated explanations must cite current source and update via existing drift/steward machinery. Treat as optional product scope pending Avi's selection rather than an implicit prerequisite for core correctness.   — note: Moved by D-016 [owner:Avi 2026-10-15] to native-code-intelligence-optional-evaluations-2026-10-15 (P-028→P-001, P-029→P-002, P-030→P-003, P-031→P-004, P-032→P-005). Not abandoned: optional evaluations now follow the core plan.",
            "storedStatus": "dropped",
            "importance": "low",
            "blockedBy": [
              "P-016",
              "P-020",
              "P-021",
              "P-026"
            ],
            "decisionRefs": [],
            "phase": "Phase 7 — Captured optional roadmap",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "dropped",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": "stored status is 'dropped' but blocked-by dependency (P-026) has not resolved — effectiveStatus is 'dropped' because a completed item cannot be blocked. The edge is likely stale, or was only partly required (the dependent finished against a partial result). Drop or repoint the blocked-by edge with plans:set-content if it no longer holds; if the dependency really was required in full, this item may have been closed early."
          },
          "coverage": {
            "level": "held-stalled",
            "links": [
              {
                "id": "WI-10007892",
                "rel": "plan_item_stamp",
                "activity": "stalled",
                "terminal": false
              }
            ]
          }
        },
        {
          "plan": "native-code-intelligence-ecosystem-and-dream-2026-10-09",
          "archived": false,
          "item": {
            "id": "P-030",
            "text": "Evaluate an expert graph-query escape hatch using the existing query surface/store where possible. Select a bounded structural-query design only after reuse search and demonstrated needs; retain auth/scope/cost limits. Do not introduce Cypher or a new durable graph database merely to imitate GitNexus.   — note: Moved by D-016 [owner:Avi 2026-10-15] to native-code-intelligence-optional-evaluations-2026-10-15 (P-028→P-001, P-029→P-002, P-030→P-003, P-031→P-004, P-032→P-005). Not abandoned: optional evaluations now follow the core plan.",
            "storedStatus": "dropped",
            "importance": "low",
            "blockedBy": [
              "P-003",
              "P-008",
              "P-019",
              "P-026"
            ],
            "decisionRefs": [],
            "phase": "Phase 7 — Captured optional roadmap",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "dropped",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": "stored status is 'dropped' but blocked-by dependency (P-026) has not resolved — effectiveStatus is 'dropped' because a completed item cannot be blocked. The edge is likely stale, or was only partly required (the dependent finished against a partial result). Drop or repoint the blocked-by edge with plans:set-content if it no longer holds; if the dependency really was required in full, this item may have been closed early."
          },
          "coverage": {
            "level": "held-stalled",
            "links": [
              {
                "id": "WI-10007893",
                "rel": "plan_item_stamp",
                "activity": "stalled",
                "terminal": false
              }
            ]
          }
        },
        {
          "plan": "native-code-intelligence-ecosystem-and-dream-2026-10-09",
          "archived": false,
          "item": {
            "id": "P-031",
            "text": "Evaluate statement-level control/data dependence and taint/security integration as a separate validated capability using maintained analyzers where suitable. Compare precise positive/negative and dynamic-boundary cases before routing security claims. GitNexus's optional PDG index does not establish our vulnerability-detection accuracy; licences and build prerequisites require explicit admission.   — note: Moved by D-016 [owner:Avi 2026-10-15] to native-code-intelligence-optional-evaluations-2026-10-15 (P-028→P-001, P-029→P-002, P-030→P-003, P-031→P-004, P-032→P-005). Not abandoned: optional evaluations now follow the core plan.",
            "storedStatus": "dropped",
            "importance": "low",
            "blockedBy": [
              "P-002",
              "P-004",
              "P-005",
              "P-026"
            ],
            "decisionRefs": [],
            "phase": "Phase 7 — Captured optional roadmap",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "dropped",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": "stored status is 'dropped' but blocked-by dependency (P-026) has not resolved — effectiveStatus is 'dropped' because a completed item cannot be blocked. The edge is likely stale, or was only partly required (the dependent finished against a partial result). Drop or repoint the blocked-by edge with plans:set-content if it no longer holds; if the dependency really was required in full, this item may have been closed early."
          },
          "coverage": {
            "level": "complete",
            "links": [
              {
                "id": "WI-10007894",
                "rel": "plan_item_stamp",
                "activity": "free",
                "terminal": true
              }
            ]
          }
        },
        {
          "plan": "native-code-intelligence-ecosystem-and-dream-2026-10-09",
          "archived": false,
          "item": {
            "id": "P-032",
            "text": "Evaluate apparently-unreached exports, test gaps and reusable/duplicate mechanism discovery across languages. Account for reflection, plugins, public entry points and generated consumers. Present static hypotheses with evidence rather than declaring code dead. Integrate with existing search, review and work records only if the independent evaluation shows value.   — note: Moved by D-016 [owner:Avi 2026-10-15] to native-code-intelligence-optional-evaluations-2026-10-15 (P-028→P-001, P-029→P-002, P-030→P-003, P-031→P-004, P-032→P-005). Not abandoned: optional evaluations now follow the core plan.",
            "storedStatus": "dropped",
            "importance": "low",
            "blockedBy": [
              "P-008",
              "P-011",
              "P-020",
              "P-026"
            ],
            "decisionRefs": [],
            "phase": "Phase 7 — Captured optional roadmap",
            "lineNumber": 0,
            "rawLine": "",
            "effectiveStatus": "dropped",
            "unresolvedBlockers": [],
            "needsHuman": false,
            "staleBlockedHint": "stored status is 'dropped' but blocked-by dependency (P-026) has not resolved — effectiveStatus is 'dropped' because a completed item cannot be blocked. The edge is likely stale, or was only partly required (the dependent finished against a partial result). Drop or repoint the blocked-by edge with plans:set-content if it no longer holds; if the dependency really was required in full, this item may have been closed early."
          },
          "coverage": {
            "level": "held-stalled",
            "links": [
              {
                "id": "WI-10007895",
                "rel": "plan_item_stamp",
                "activity": "stalled",
                "terminal": false
              }
            ]
          }
        }
      ]
    }
  ]
}
