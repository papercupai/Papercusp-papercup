---
rel_path: "evidence/plan-shipping-friction-repair-20261026/coverage-census-v4.json"
updated_at: 1793043906896
_body: "content"
---

{
  "schemaVersion": 1,
  "plan": "plan-shipping-friction-repair-2026-10-26",
  "status": "contract-population-unverified",
  "basis": {
    "baseSha": "1ab91256b6bb2a215d2a3ffe9ef1eb8b42d722a4",
    "repairTargetSha": "59affc71fd45d8215cd10a0949fda07edb2d84d9",
    "sourceCommits": [
      "530fabb62e",
      "3718fe93d6",
      "59affc71fd"
    ],
    "observedHead": "82c8e15b190f87c57cabedfc5035d03589152982",
    "procedure": "git diff baseSha repairTargetSha -- the six footprint paths; inspect every changed code hunk and map observable behaviors. git diff repairTargetSha HEAD and git diff HEAD on those paths returned no differences at capture. Do not extend this claim to test bytes or unenumerated paths.",
    "diffStats": [
      {
        "path": "packages/operator-core/lib/acceptance-bar-lifecycle-evaluator.ts",
        "added": 8,
        "removed": 6
      },
      {
        "path": "packages/operator-core/lib/agent-tools/plans/acceptance-drain-filing.ts",
        "added": 6,
        "removed": 1
      },
      {
        "path": "packages/operator-core/lib/events/builtin-actions.ts",
        "added": 9,
        "removed": 4
      },
      {
        "path": "packages/operator-core/lib/plan-acceptance-gate.ts",
        "added": 24,
        "removed": 4
      },
      {
        "path": "packages/operator-core/lib/plan-items/plan-drain-rule.ts",
        "added": 25,
        "removed": 8
      },
      {
        "path": "packages/operator-core/lib/rubrics.ts",
        "added": 6,
        "removed": 1
      }
    ]
  },
  "population": [
    {
      "id": "B-01",
      "behavior": "Classify a present undecodable acceptance rubric separately from absence and expose an honest runtime repair.",
      "sourcePaths": [
        "packages/operator-core/lib/rubrics.ts",
        "packages/operator-core/lib/plan-acceptance-gate.ts"
      ],
      "barKeys": [
        "R-1"
      ],
      "cases": [
        {
          "file": "packages/operator-core/lib/plan-acceptance-gate.test.ts",
          "testName": "an unreadable acceptance rubric refuses without prescribing a replacement"
        },
        {
          "file": "packages/operator-core/lib/plan-acceptance-gate.test.ts",
          "testName": "collect mode records an unreadable rubric revision and skips the vetting evaluation"
        },
        {
          "file": "packages/operator-core/lib/rubrics.integration.test.ts",
          "testName": "strict acceptance lookup distinguishes an unreadable existing rubric from absence"
        },
        {
          "file": "packages/operator-core/lib/rubrics.integration.test.ts",
          "testName": "strict acceptance lookup reports a forward-schema contract as unreadable rather than missing"
        }
      ],
      "plausibleWrong": "The reader silently drops the row and the gate prescribes authoring a replacement rubric."
    },
    {
      "id": "B-02",
      "behavior": "Choose the blocking pre-grading phase's repair before the later ship-phase author-verdict instruction.",
      "sourcePaths": [
        "packages/operator-core/lib/plan-acceptance-gate.ts"
      ],
      "barKeys": [
        "R-2"
      ],
      "cases": [
        {
          "file": "packages/operator-core/lib/agent-tools/plans/set-plan-status-repair.test.ts",
          "testName": "never copies a repair from a different lifecycle phase"
        },
        {
          "file": "packages/operator-core/lib/agent-tools/plans/set-plan-status-repair.test.ts",
          "testName": "routes the blocking pre-grading repair before a later author verdict"
        },
        {
          "file": "packages/operator-core/lib/agent-tools/plans/set-plan-status-repair.test.ts",
          "testName": "never proposes an author verdict while pre-grading proof is missing"
        }
      ],
      "plausibleWrong": "A missing proof or unvetted contract proposes an author verdict."
    },
    {
      "id": "B-03",
      "behavior": "Expose phase-specific BAR diagnostic actions for proof, runtime and grader prerequisites.",
      "sourcePaths": [
        "packages/operator-core/lib/acceptance-bar-lifecycle-evaluator.ts"
      ],
      "barKeys": [
        "R-7"
      ],
      "cases": [
        {
          "file": "packages/operator-core/lib/acceptance-bar-lifecycle-evaluator.test.ts",
          "testName": "separates independent grading and its later author verdict from author repairs"
        },
        {
          "file": "packages/operator-core/lib/acceptance-bar-lifecycle-evaluator.test.ts",
          "testName": "names the prioritised repair ACTION, not just the code"
        },
        {
          "file": "packages/operator-core/lib/acceptance-bar-lifecycle-evaluator.test.ts",
          "testName": "blocks grading on proof adequacy, freshness, and declared live plane/runtime"
        },
        {
          "file": "packages/operator-core/lib/acceptance-bar-contract-snapshot.test.ts",
          "testName": "turns a reader failure into an explicit unavailable source and blocked repair"
        }
      ],
      "plausibleWrong": "The snapshot or lifecycle reports a blocker without its actionable phase-specific repair."
    },
    {
      "id": "B-04",
      "behavior": "Preserve the observation age of the same outstanding blocker when only serving build provenance changes.",
      "sourcePaths": [
        "packages/operator-core/lib/agent-tools/plans/acceptance-drain-filing.ts"
      ],
      "barKeys": [
        "R-3"
      ],
      "cases": [
        {
          "file": "packages/operator-core/lib/agent-tools/plans/acceptance-drain-filing.test.ts",
          "testName": "keeps an unchanged blocker overdue when only the serving build changes"
        },
        {
          "file": "packages/operator-core/lib/agent-tools/plans/acceptance-drain-filing.test.ts",
          "testName": "starts a new blocker episode when the previous repair is cleared"
        }
      ],
      "plausibleWrong": "A serving build refresh renews the overdue blocker's escalation clock."
    },
    {
      "id": "B-05",
      "behavior": "Propagate the authenticated finishing actor through all plan-drain reaction rules while rejecting payload/system/transport identities.",
      "sourcePaths": [
        "packages/operator-core/lib/plan-items/plan-drain-rule.ts"
      ],
      "barKeys": [
        "R-8"
      ],
      "cases": [
        {
          "file": "packages/operator-core/lib/plan-items/plan-drain-rule.test.ts",
          "testName": "carries the authenticated finishing actor through the reaction action"
        },
        {
          "file": "packages/operator-core/lib/plan-items/plan-drain-rule.test.ts",
          "testName": "keeps a clientless superuser carry claimable"
        },
        {
          "file": "packages/operator-core/lib/plan-items/plan-drain-rule.test.ts",
          "testName": "does not assign a carry to system:plan-drain"
        },
        {
          "file": "packages/operator-core/lib/plan-items/plan-drain-rule.test.ts",
          "testName": "does not assign a carry to mcp-call-123"
        },
        {
          "file": "packages/operator-core/lib/plan-items/plan-drain-rule.test.ts",
          "testName": "does not assign a carry to harness:papercusp"
        }
      ],
      "plausibleWrong": "The reaction drops the actor or assigns an identity chosen in caller args."
    },
    {
      "id": "B-06",
      "behavior": "Carry the actual actor and workspace through the builtin action into the transactional keyed acceptance handoff.",
      "sourcePaths": [
        "packages/operator-core/lib/events/builtin-actions.ts"
      ],
      "barKeys": [
        "R-8"
      ],
      "cases": [
        {
          "file": "packages/operator-core/lib/agent-tools/plans/__tests__/acceptance-carry.integration.test.ts",
          "testName": "hands a content-completion reaction to its finishing actor in the plan workspace"
        }
      ],
      "plausibleWrong": "The handoff runs in ambient workspace or loses the finishing actor."
    }
  ],
  "preservationControls": [
    {
      "barKey": "R-6",
      "cases": [
        {
          "file": "packages/operator-core/lib/plan-acceptance-gate.test.ts",
          "testName": "does not recruit a grader while pre-grading proof remains inadequate"
        },
        {
          "file": "packages/operator-core/lib/plan-acceptance-gate.test.ts",
          "testName": "does not recruit through incomplete METHOD or vetting prerequisites"
        },
        {
          "file": "packages/operator-core/lib/plan-acceptance-gate.test.ts",
          "testName": "CONTROL: a genuine unchanged FAIL does not recruit — the card is not dropped"
        },
        {
          "file": "packages/operator-core/lib/plan-acceptance-gate.test.ts",
          "testName": "grading-recruitment unfinished-item exception > admits an unfinished tail only when every item is effectively audited not-code"
        },
        {
          "file": "packages/operator-core/lib/plan-acceptance-gate.test.ts",
          "testName": "grading-recruitment unfinished-item exception > refuses missing audit evidence"
        },
        {
          "file": "packages/operator-core/lib/plan-acceptance-gate.test.ts",
          "testName": "grading-recruitment unfinished-item exception > refuses implemented audit evidence"
        },
        {
          "file": "packages/operator-core/lib/plan-acceptance-gate.test.ts",
          "testName": "grading-recruitment unfinished-item exception > refuses mixed tail evidence"
        },
        {
          "file": "packages/operator-core/lib/plan-acceptance-gate.test.ts",
          "testName": "grading-recruitment unfinished-item exception > does not manufacture an exception when there are no unfinished items"
        },
        {
          "file": "packages/operator-core/lib/plan-acceptance-gate.test.ts",
          "testName": "grading-recruitment unfinished-item exception > reaches the independent grading request for an audited not-code unfinished tail"
        },
        {
          "file": "packages/operator-core/lib/plan-acceptance-gate.test.ts",
          "testName": "grading-recruitment unfinished-item exception > blocks the independent grading request for an unaudited unfinished tail"
        }
      ]
    },
    {
      "barKey": "R-9",
      "cases": [
        {
          "file": "packages/operator-core/lib/agent-tools/plans/__tests__/acceptance-carry.integration.test.ts",
          "testName": "does not overwrite a held acceptance claim on a keyed retry"
        },
        {
          "file": "packages/operator-core/lib/agent-tools/plans/__tests__/acceptance-carry.integration.test.ts",
          "testName": "refreshes one keyed filing across blocker changes and readiness while preserving age evidence"
        }
      ]
    },
    {
      "barKey": "R-10",
      "cases": [
        {
          "file": "packages/operator-core/lib/acceptance-seat-succession.test.ts",
          "testName": "grants the seat when the author has ended and the caller holds the plan work-item"
        },
        {
          "file": "packages/operator-core/lib/acceptance-seat-succession.test.ts",
          "testName": "names the claim route, and warns a PEER off rebind while preserving it for a self-successor"
        },
        {
          "file": "packages/operator-core/lib/plan-acceptance-gate.test.ts",
          "testName": "accepts an audited successor verdict but never counts that successor as the independent grader"
        }
      ]
    },
    {
      "barKey": "R-13",
      "cases": [
        {
          "file": "packages/operator-core/lib/agent-tools/plans/__tests__/acceptance-carry.integration.test.ts",
          "testName": "makes an ended executor carry claimable and assigns a successor without disturbing a live carry"
        }
      ]
    }
  ],
  "testMaintenance": [
    {
      "file": "packages/operator-core/lib/rubrics.integration.test.ts",
      "testName": "refreshes a stale stored BAR readiness Now after a canonical acceptance amendment",
      "reason": "replace obsolete clear-state assertion with actual current-vetting blocker"
    },
    {
      "file": "packages/operator-core/lib/rubrics.integration.test.ts",
      "testName": "EI-267115: survives a real PostgreSQL idle-transaction timeout during independent snapshot reads",
      "reason": "distinguish pre-transaction and post-commit refresh reads while measuring advisory locks and retaining calibrated timeout"
    }
  ],
  "carrier": {
    "writer": "work_items:complete",
    "planItem": "P-004",
    "field": "completion.verification.coverage",
    "instructions": "Resolve P-004's canonical promoted work-item. Its completion must enumerate this artifact's six behavior IDs and six diff paths, partition the exact population into checked/notChecked/notApplicable, and set residue explicitly. Each checked behavior needs current passing exact-case ledger references in testsRun/testResult and source/test fingerprints. Bind that same census and the current per-case results as R12 evidence before final acceptance. This artifact declares the population, not a passing result."
  },
  "unmappedSourcePaths": [],
  "unmappedBehaviorResidue": [],
  "currentProofStatus": "not yet bound; the targeted runs are observed guards, not current full-suite acceptance evidence"
}

