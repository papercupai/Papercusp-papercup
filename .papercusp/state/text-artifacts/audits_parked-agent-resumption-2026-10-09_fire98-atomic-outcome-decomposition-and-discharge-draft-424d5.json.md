---
rel_path: "audits/parked-agent-resumption-2026-10-09/fire98-atomic-outcome-decomposition-and-discharge-draft-424d5.json"
updated_at: 1792140539806
_body: "content"
---

{
  "schemaVersion": "parked-atomic-construction-decomposition-v1",
  "status": "DRAFT_NOT_REGISTERED_NOT_ACCEPTANCE",
  "workItem": "WI-6554700010008887",
  "plan": {
    "slug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
    "version": 66,
    "contentHash": "f46c23ae46f17d96ba532461780a19207876be7d827f7c7931dcfa971211316d"
  },
  "rubric": {
    "revision": 8,
    "meaningRevision": 7,
    "barSetHash": "60f6e836d2e49f265a69481eaa16add244ed9031cd7bd0f63cd50e6f04594d69"
  },
  "sourceArtifact": "audits/parked-agent-resumption-2026-10-09/fire97-method-coverage-and-atomic-outcome-proposals-424d5-v2.json",
  "sourceFire96Artifact": "audits/parked-agent-resumption-2026-10-09/fire96-inverse23-failure-surfaces-and-exact14-adequacy-424d5-v2.json",
  "originalOutcomes": "R1..14 remain unchanged; this draft adds no registered criterion and reuses the existing P004/P007/P008/P011/P012/P013 lanes.",
  "atomicity": {
    "rule": "one independently observable output or verdict per candidate; supporting branch controls do not themselves substitute for the stated outcome",
    "validator": "acceptance-bar-projection.ts -> specBehaviorNonAtomicReason",
    "result": {
      "checked": 20,
      "issues": [],
      "exitCode": 0,
      "procedure": "Called maintained specBehaviorNonAtomicReason for every candidate condition from the canonical tree via node --import tsx; this validates syntax only, not semantic completeness or runtime acceptance."
    }
  },
  "candidates": [
    {
      "draftId": "F98-15A",
      "fromFire97Prototype": "R-15",
      "planItems": [
        "P-011"
      ],
      "sourceDecisions": [
        "D-012"
      ],
      "provenance": "derived from existing owner-backed plan item and governing decision; not a newly asserted owner directive",
      "intent": {
        "request": "The agents-stranded standing alarm is active at a measured stranded count of at least 5.",
        "sourceRefs": [
          "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20",
          "plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-012"
        ]
      },
      "acceptance": {
        "condition": "The agents-stranded standing alarm is active at a measured stranded count of at least 5.",
        "falsifier": "A readable stranded count of 5 or more produces no agents-stranded alarm.",
        "evidencePlane": "live",
        "requiredScope": [
          "packages/operator-core/lib/system-health/agent-strand-census.ts",
          "packages/operator-core/lib/system-health/liveness-alarm.ts"
        ],
        "requiredTestLayers": [
          "e2e"
        ]
      },
      "verification": {
        "check": {
          "kind": "tests",
          "files": [
            "packages/operator-core/lib/system-health/liveness-alarm-agent-strand.test.ts",
            "packages/operator-core/lib/system-health/liveness-alarm-current-build.e2e.test.ts"
          ]
        },
        "method": "Use the named maintained test files and exact cases matching the controls below. Read ledger-backed evidence and compare source/test/runtime fingerprints before deciding whether fresh execution is necessary. A test's existence or this draft's syntactic validity is not a passing observation. Use the maintained current-build isolated operator-api route after its clean prerequisite preflight; record the actual loaded runtime. Do not re-run terminal proof or an expensive current R12 case for recall.",
        "controls": [
          "exact 4/5 boundary",
          "independent of wedged count",
          "reuse census/silent-halt any-live predicate"
        ]
      },
      "status": "DRAFT_NOT_REGISTERED",
      "unresolved": []
    },
    {
      "draftId": "F98-15B",
      "fromFire97Prototype": "R-15",
      "planItems": [
        "P-011"
      ],
      "sourceDecisions": [
        "D-012"
      ],
      "provenance": "derived from existing owner-backed plan item and governing decision; not a newly asserted owner directive",
      "intent": {
        "request": "An unobserved census leg preserves its existing population alarm.",
        "sourceRefs": [
          "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20",
          "plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-012"
        ]
      },
      "acceptance": {
        "condition": "An unobserved census leg preserves its existing population alarm.",
        "falsifier": "An unreadable leg, errored panel, or missing census snapshot clears its existing alarm.",
        "evidencePlane": "live",
        "requiredScope": [
          "packages/operator-core/lib/system-health/agent-strand-census.ts",
          "packages/operator-core/lib/system-health/liveness-alarm.ts"
        ],
        "requiredTestLayers": [
          "e2e"
        ]
      },
      "verification": {
        "check": {
          "kind": "tests",
          "files": [
            "packages/operator-core/lib/system-health/liveness-alarm-agent-strand.test.ts",
            "packages/operator-core/lib/system-health/liveness-alarm-current-build.e2e.test.ts"
          ]
        },
        "method": "Use the named maintained test files and exact cases matching the controls below. Read ledger-backed evidence and compare source/test/runtime fingerprints before deciding whether fresh execution is necessary. A test's existence or this draft's syntactic validity is not a passing observation. Use the maintained current-build isolated operator-api route after its clean prerequisite preflight; record the actual loaded runtime. Do not re-run terminal proof or an expensive current R12 case for recall.",
        "controls": [
          "unreadable wedged leg",
          "unreadable stranded leg",
          "errored panel",
          "older-build missing-census snapshot",
          "readable below-threshold recovery control"
        ]
      },
      "status": "DRAFT_NOT_REGISTERED",
      "unresolved": []
    },
    {
      "draftId": "F98-15C",
      "fromFire97Prototype": "R-15",
      "planItems": [
        "P-011"
      ],
      "sourceDecisions": [
        "D-012"
      ],
      "provenance": "derived from existing owner-backed plan item and governing decision; not a newly asserted owner directive",
      "intent": {
        "request": "The coordination panel exposes each measured wedged-host class count.",
        "sourceRefs": [
          "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20",
          "plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-012"
        ]
      },
      "acceptance": {
        "condition": "The coordination panel exposes each measured wedged-host class count.",
        "falsifier": "A measured host class has an absent or incorrect panel count.",
        "evidencePlane": "live",
        "requiredScope": [
          "packages/operator-core/lib/system-health/agent-strand-census.ts",
          "packages/operator-core/lib/system-health/liveness-alarm.ts"
        ],
        "requiredTestLayers": [
          "e2e"
        ]
      },
      "verification": {
        "check": {
          "kind": "tests",
          "files": [
            "packages/operator-core/lib/system-health/agent-strand-census.test.ts",
            "packages/operator-core/lib/system-health/liveness-alarm-agent-strand.test.ts",
            "packages/operator-core/lib/system-health/liveness-alarm-current-build.e2e.test.ts"
          ]
        },
        "method": "Use the named maintained test files and exact cases matching the controls below. Read ledger-backed evidence and compare source/test/runtime fingerprints before deciding whether fresh execution is necessary. A test's existence or this draft's syntactic validity is not a passing observation. Use the maintained current-build isolated operator-api route after its clean prerequisite preflight; record the actual loaded runtime. Do not re-run terminal proof or an expensive current R12 case for recall.",
        "controls": [
          "same census writer and class partition",
          "no rederived liveness",
          "unobserved class remains unknown"
        ]
      },
      "status": "DRAFT_NOT_REGISTERED",
      "unresolved": []
    },
    {
      "draftId": "F98-15D",
      "fromFire97Prototype": "R-15",
      "planItems": [
        "P-011"
      ],
      "sourceDecisions": [
        "D-012"
      ],
      "provenance": "derived from existing owner-backed plan item and governing decision; not a newly asserted owner directive",
      "intent": {
        "request": "A population strand condition leaves the coordination panel at WARN severity.",
        "sourceRefs": [
          "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20",
          "plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-012"
        ]
      },
      "acceptance": {
        "condition": "A population strand condition leaves the coordination panel at WARN severity.",
        "falsifier": "The population condition elevates the coordination panel to CRIT and duplicates its population alarm through panel:coordination.",
        "evidencePlane": "live",
        "requiredScope": [
          "packages/operator-core/lib/system-health/agent-strand-census.ts",
          "packages/operator-core/lib/system-health/liveness-alarm.ts"
        ],
        "requiredTestLayers": [
          "e2e"
        ]
      },
      "verification": {
        "check": {
          "kind": "tests",
          "files": [
            "packages/operator-core/lib/system-health/liveness-alarm-agent-strand.test.ts",
            "packages/operator-core/lib/system-health/liveness-alarm-current-build.e2e.test.ts"
          ]
        },
        "method": "Use the named maintained test files and exact cases matching the controls below. Read ledger-backed evidence and compare source/test/runtime fingerprints before deciding whether fresh execution is necessary. A test's existence or this draft's syntactic validity is not a passing observation. Use the maintained current-build isolated operator-api route after its clean prerequisite preflight; record the actual loaded runtime. Do not re-run terminal proof or an expensive current R12 case for recall.",
        "controls": [
          "wedged-only condition",
          "stranded-only condition",
          "both populations",
          "nonpopulation panel conditions remain independent"
        ]
      },
      "status": "DRAFT_NOT_REGISTERED",
      "unresolved": []
    },
    {
      "draftId": "F98-15E",
      "fromFire97Prototype": "R-15",
      "planItems": [
        "P-011"
      ],
      "sourceDecisions": [
        "D-012"
      ],
      "provenance": "derived from existing owner-backed plan item and governing decision; not a newly asserted owner directive",
      "intent": {
        "request": "Repeated observations of one open population-alarm episode produce one owner page.",
        "sourceRefs": [
          "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20",
          "plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-012"
        ]
      },
      "acceptance": {
        "condition": "Repeated observations of one open population-alarm episode produce one owner page.",
        "falsifier": "The same open episode produces another owner page before its documented recovery and flap-suppression boundary.",
        "evidencePlane": "live",
        "requiredScope": [
          "packages/operator-core/lib/system-health/agent-strand-census.ts",
          "packages/operator-core/lib/system-health/liveness-alarm.ts"
        ],
        "requiredTestLayers": [
          "e2e"
        ]
      },
      "verification": {
        "check": {
          "kind": "tests",
          "files": [
            "packages/operator-core/lib/system-health/liveness-alarm-agent-strand.test.ts",
            "packages/operator-core/lib/system-health/liveness-alarm-current-build.e2e.test.ts"
          ]
        },
        "method": "Use the named maintained test files and exact cases matching the controls below. Read ledger-backed evidence and compare source/test/runtime fingerprints before deciding whether fresh execution is necessary. A test's existence or this draft's syntactic validity is not a passing observation. Use the maintained current-build isolated operator-api route after its clean prerequisite preflight; record the actual loaded runtime. Do not re-run terminal proof or an expensive current R12 case for recall.",
        "controls": [
          "episode dedupe",
          "flap suppression",
          "observed recovery then genuine new episode"
        ]
      },
      "status": "DRAFT_NOT_REGISTERED",
      "unresolved": []
    },
    {
      "draftId": "F98-16",
      "fromFire97Prototype": "R-16",
      "planItems": [
        "P-013"
      ],
      "sourceDecisions": [],
      "provenance": "derived from existing owner-backed plan item and governing decision; not a newly asserted owner directive",
      "intent": {
        "request": "The eligible delayed census binding-stranded count does not exceed the frozen original live baseline.",
        "sourceRefs": [
          "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20"
        ]
      },
      "acceptance": {
        "condition": "The eligible delayed census binding-stranded count does not exceed the frozen original live baseline.",
        "falsifier": "The eligible delayed count exceeds that exact baseline.",
        "evidencePlane": "live",
        "requiredScope": [
          "parked-agent census rerun"
        ],
        "requiredTestLayers": [
          "e2e"
        ]
      },
      "verification": {
        "check": {
          "kind": "instrument",
          "instrumentKey": "parked-agent-census"
        },
        "method": "Reuse the maintained parked-agent-census instrument from original R14. Resolve exact baseline and all-fix runtime anchor from WI-10008164. Before anchor+24h return not-yet-eligible. At the eligible delayed time archive original query configuration, exact population and complete per-owner outcomes; use the exact preserved baseline/owner bound for this outcome. Missing inputs remain unknown. Bind the maintained e2e proof; do not invent a test filename or waive actual elapsed time.",
        "controls": [
          "exact original baseline artifact and population",
          "same scripted query",
          "final all-fix loaded-runtime anchor",
          "actual elapsed interval at least 24h",
          "missing baseline or anchor is unknown"
        ]
      },
      "status": "DRAFT_BLOCKED_INPUT",
      "unresolved": [
        "Resolve the exact original baseline selector without changing its population; preserve an unavailable baseline as unknown."
      ]
    },
    {
      "draftId": "F98-17",
      "fromFire97Prototype": "R-17",
      "planItems": [
        "P-013"
      ],
      "sourceDecisions": [],
      "provenance": "derived from existing owner-backed plan item and governing decision; not a newly asserted owner directive",
      "intent": {
        "request": "The eligible delayed AUTO+claims+no-wake count satisfies the owner-approved near-zero bound frozen before outcomes.",
        "sourceRefs": [
          "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20"
        ]
      },
      "acceptance": {
        "condition": "The eligible delayed AUTO+claims+no-wake count satisfies the owner-approved near-zero bound frozen before outcomes.",
        "falsifier": "The eligible delayed count exceeds that frozen owner-approved bound.",
        "evidencePlane": "live",
        "requiredScope": [
          "parked-agent census rerun"
        ],
        "requiredTestLayers": [
          "e2e"
        ]
      },
      "verification": {
        "check": {
          "kind": "instrument",
          "instrumentKey": "parked-agent-census"
        },
        "method": "Reuse the maintained parked-agent-census instrument from original R14. Resolve exact baseline and all-fix runtime anchor from WI-10008164. Before anchor+24h return not-yet-eligible. At the eligible delayed time archive original query configuration, exact population and complete per-owner outcomes; use the exact preserved baseline/owner bound for this outcome. Missing inputs remain unknown. Bind the maintained e2e proof; do not invent a test filename or waive actual elapsed time.",
        "controls": [
          "owner-authored bound before outcome observation",
          "same no-wake definition and population",
          "typed blocker-only versus mixed actionable holds",
          "final all-fix runtime anchor",
          "actual elapsed interval at least 24h"
        ]
      },
      "status": "DRAFT_BLOCKED_INPUT",
      "unresolved": [
        "Owner interpretation of near zero remains pending; no numeric threshold is invented.",
        "This parameterized draft cannot be applied or graded before that answer."
      ]
    },
    {
      "draftId": "F98-18A",
      "fromFire97Prototype": "R-18",
      "planItems": [
        "P-007",
        "P-013"
      ],
      "sourceDecisions": [
        "D-006",
        "D-008",
        "D-009",
        "D-023"
      ],
      "provenance": "derived from existing owner-backed plan item and governing decision; not a newly asserted owner directive",
      "intent": {
        "request": "Silent-halt classifies a parked autonomous session as stranded exactly when it holds actionable work without an eligible live wake source.",
        "sourceRefs": [
          "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20",
          "plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-006",
          "plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-008",
          "plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-009",
          "plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-023"
        ]
      },
      "acceptance": {
        "condition": "An otherwise eligible parked autonomous session receives a silent-halt verdict exactly when it holds actionable work without an eligible live wake source.",
        "falsifier": "An own-inbox or dead-target watch hides actionable held work, a live untimed event watch is rejected, or blocker-only held work is counted as actionable.",
        "evidencePlane": "tree",
        "requiredScope": [
          "packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts"
        ],
        "requiredTestLayers": [
          "unit"
        ]
      },
      "verification": {
        "check": {
          "kind": "tests",
          "files": [
            "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts"
          ]
        },
        "method": "Use the named maintained test files and exact cases matching the controls below. Read ledger-backed evidence and compare source/test/runtime fingerprints before deciding whether fresh execution is necessary. A test's existence or this draft's syntactic validity is not a passing observation. Do not re-run terminal proof or an expensive current R12 case for recall.",
        "controls": [
          "own inbox exclusion",
          "self-held done/terminal/missing target exclusions",
          "any-live untimed watch positive control",
          "blocked or needs-human plus active typed external blocker excluded",
          "wip/plain blocked/internal-dependency holds stay actionable",
          "mixed holds retain actionable verdict and excluded IDs",
          "retain eligibility/cadence/recent-turn/fleet-control exclusions; do not broaden candidate population"
        ]
      },
      "status": "DRAFT_NOT_REGISTERED",
      "unresolved": []
    },
    {
      "draftId": "F98-18B",
      "fromFire97Prototype": "R-18",
      "planItems": [
        "P-007"
      ],
      "sourceDecisions": [
        "D-006"
      ],
      "provenance": "derived from existing owner-backed plan item and governing decision; not a newly asserted owner directive",
      "intent": {
        "request": "A silent-halt recovery attempt wakes an eligible host that does not require relaunch.",
        "sourceRefs": [
          "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20",
          "plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-006"
        ]
      },
      "acceptance": {
        "condition": "A silent-halt recovery attempt wakes an eligible host that does not require relaunch.",
        "falsifier": "A healthy, recoverable-on-wake, no-host, or read-failure branch suppresses the bounded wake attempt.",
        "evidencePlane": "tree",
        "requiredScope": [
          "packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts"
        ],
        "requiredTestLayers": [
          "unit"
        ]
      },
      "verification": {
        "check": {
          "kind": "tests",
          "files": [
            "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts"
          ]
        },
        "method": "Use the named maintained test files and exact cases matching the controls below. Read ledger-backed evidence and compare source/test/runtime fingerprints before deciding whether fresh execution is necessary. A test's existence or this draft's syntactic validity is not a passing observation. Do not re-run terminal proof or an expensive current R12 case for recall.",
        "controls": [
          "host classification",
          "existing wake fan bound",
          "measured pickup remains distinct from queued wake"
        ]
      },
      "status": "DRAFT_NOT_REGISTERED",
      "unresolved": []
    },
    {
      "draftId": "F98-18C",
      "fromFire97Prototype": "R-18",
      "planItems": [
        "P-007"
      ],
      "sourceDecisions": [
        "D-006"
      ],
      "provenance": "derived from existing owner-backed plan item and governing decision; not a newly asserted owner directive",
      "intent": {
        "request": "A silent-halt verdict for a host requiring relaunch produces an actionable host-recovery page.",
        "sourceRefs": [
          "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20",
          "plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-006"
        ]
      },
      "acceptance": {
        "condition": "A silent-halt verdict for a host requiring relaunch produces an actionable host-recovery page.",
        "falsifier": "An unhealthy host receives only a futile wake or no page naming its measured condition and remedy.",
        "evidencePlane": "tree",
        "requiredScope": [
          "packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts"
        ],
        "requiredTestLayers": [
          "unit"
        ]
      },
      "verification": {
        "check": {
          "kind": "tests",
          "files": [
            "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts"
          ]
        },
        "method": "Use the named maintained test files and exact cases matching the controls below. Read ledger-backed evidence and compare source/test/runtime fingerprints before deciding whether fresh execution is necessary. A test's existence or this draft's syntactic validity is not a passing observation. Do not re-run terminal proof or an expensive current R12 case for recall.",
        "controls": [
          "auth/quota/unbound/pending-turn classes",
          "no ordinary wake on needs-relaunch",
          "new-page versus existing-page behavior"
        ]
      },
      "status": "DRAFT_NOT_REGISTERED",
      "unresolved": []
    },
    {
      "draftId": "F98-18D",
      "fromFire97Prototype": "R-18",
      "planItems": [
        "P-007"
      ],
      "sourceDecisions": [
        "D-006"
      ],
      "provenance": "derived from existing owner-backed plan item and governing decision; not a newly asserted owner directive",
      "intent": {
        "request": "A fleet member's newly created silent-halt page alerts its fleet leader once per halt epoch.",
        "sourceRefs": [
          "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20",
          "plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-006"
        ]
      },
      "acceptance": {
        "condition": "A fleet member's newly created silent-halt page alerts its fleet leader once per halt epoch.",
        "falsifier": "A new fleet-member page omits its leader alert or a deduped page repeats that alert in the same epoch.",
        "evidencePlane": "tree",
        "requiredScope": [
          "packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts"
        ],
        "requiredTestLayers": [
          "unit"
        ]
      },
      "verification": {
        "check": {
          "kind": "tests",
          "files": [
            "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts"
          ]
        },
        "method": "Use the named maintained test files and exact cases matching the controls below. Read ledger-backed evidence and compare source/test/runtime fingerprints before deciding whether fresh execution is necessary. A test's existence or this draft's syntactic validity is not a passing observation. Do not re-run terminal proof or an expensive current R12 case for recall.",
        "controls": [
          "new page alerts and wakes leader",
          "deduped page does not repeat",
          "nonfleet control",
          "next halt epoch"
        ]
      },
      "status": "DRAFT_NOT_REGISTERED",
      "unresolved": []
    },
    {
      "draftId": "F98-18E",
      "fromFire97Prototype": "R-18",
      "planItems": [
        "P-007"
      ],
      "sourceDecisions": [
        "D-006"
      ],
      "provenance": "derived from existing owner-backed plan item and governing decision; not a newly asserted owner directive",
      "intent": {
        "request": "Existing deduped silent-halt pages leave the configured new-page budget available to new halts.",
        "sourceRefs": [
          "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20",
          "plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-006"
        ]
      },
      "acceptance": {
        "condition": "Existing deduped silent-halt pages leave the configured new-page budget available to new halts.",
        "falsifier": "A deduped page consumes that budget or new pages exceed the configured cap.",
        "evidencePlane": "tree",
        "requiredScope": [
          "packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts"
        ],
        "requiredTestLayers": [
          "unit"
        ]
      },
      "verification": {
        "check": {
          "kind": "tests",
          "files": [
            "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts"
          ]
        },
        "method": "Use the named maintained test files and exact cases matching the controls below. Read ledger-backed evidence and compare source/test/runtime fingerprints before deciding whether fresh execution is necessary. A test's existence or this draft's syntactic validity is not a passing observation. Do not re-run terminal proof or an expensive current R12 case for recall.",
        "controls": [
          "standing pages ahead of new halt",
          "all-new mass halt capped",
          "separate wake budget"
        ]
      },
      "status": "DRAFT_NOT_REGISTERED",
      "unresolved": []
    },
    {
      "draftId": "F98-18F",
      "fromFire97Prototype": "R-18",
      "planItems": [
        "P-007"
      ],
      "sourceDecisions": [
        "D-006",
        "D-009"
      ],
      "provenance": "derived from existing owner-backed plan item and governing decision; not a newly asserted owner directive",
      "intent": {
        "request": "A stalled-loop disarm remains visible to the bounded silent-halt fallback.",
        "sourceRefs": [
          "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20",
          "plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-006",
          "plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-009"
        ]
      },
      "acceptance": {
        "condition": "A stalled-loop disarm remains visible to the bounded silent-halt fallback.",
        "falsifier": "A detector-created at-disarm await exempts the disarmed session from that fallback.",
        "evidencePlane": "tree",
        "requiredScope": [
          "packages/operator-core/lib/harness/routines/stalled-loops-guard.ts",
          "packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts"
        ],
        "requiredTestLayers": [
          "unit"
        ]
      },
      "verification": {
        "check": {
          "kind": "tests",
          "files": [
            "packages/operator-core/lib/harness/routines/stalled-loops-guard.test.ts",
            "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts"
          ]
        },
        "method": "Use the named maintained test files and exact cases matching the controls below. Read ledger-backed evidence and compare source/test/runtime fingerprints before deciding whether fresh execution is necessary. A test's existence or this draft's syntactic validity is not a passing observation. Do not re-run terminal proof or an expensive current R12 case for recall.",
        "controls": [
          "no synthetic at-disarm exemption",
          "existing genuine external awaits keep their any-live semantics",
          "threshold max(30min,5intervals)"
        ]
      },
      "status": "DRAFT_NOT_REGISTERED",
      "unresolved": []
    },
    {
      "draftId": "F98-19A",
      "fromFire97Prototype": "R-19",
      "planItems": [
        "P-004",
        "P-012"
      ],
      "sourceDecisions": [
        "D-013",
        "D-014"
      ],
      "provenance": "derived from existing owner-backed plan item and governing decision; not a newly asserted owner directive",
      "intent": {
        "request": "A Codex quota-wall host record publishes the parsed provider reset instant.",
        "sourceRefs": [
          "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20",
          "plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-013",
          "plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-014"
        ]
      },
      "acceptance": {
        "condition": "A Codex quota-wall host record publishes the parsed provider reset instant.",
        "falsifier": "A supported provider reset statement yields a missing or incorrect quotaResetAtMs on the host record.",
        "evidencePlane": "tree",
        "requiredScope": [
          "apps/operator/scripts/psu-pty-host.mjs"
        ],
        "requiredTestLayers": [
          "unit"
        ]
      },
      "verification": {
        "check": {
          "kind": "tests",
          "files": [
            "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts"
          ]
        },
        "method": "Use the named maintained test files and exact cases matching the controls below. Read ledger-backed evidence and compare source/test/runtime fingerprints before deciding whether fresh execution is necessary. A test's existence or this draft's syntactic validity is not a passing observation. Do not re-run terminal proof or an expensive current R12 case for recall.",
        "controls": [
          "absolute local-time reset",
          "relative duration",
          "ANSI/wrapped statement",
          "latest statement",
          "no-stated-reset unknown control"
        ]
      },
      "status": "DRAFT_NOT_REGISTERED",
      "unresolved": []
    },
    {
      "draftId": "F98-19B",
      "fromFire97Prototype": "R-19",
      "planItems": [
        "P-004",
        "P-012"
      ],
      "sourceDecisions": [
        "D-013",
        "D-014"
      ],
      "provenance": "derived from existing owner-backed plan item and governing decision; not a newly asserted owner directive",
      "intent": {
        "request": "A Codex quota latch releases the next same-route recovery attempt when its stated reset becomes due.",
        "sourceRefs": [
          "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20",
          "plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-013",
          "plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-014"
        ]
      },
      "acceptance": {
        "condition": "A Codex quota latch releases the next same-route recovery attempt when its stated reset becomes due.",
        "falsifier": "The reset is due but the unchanged-route attempt remains indefinitely latched.",
        "evidencePlane": "tree",
        "requiredScope": [
          "apps/operator/scripts/psu-pty-host.mjs"
        ],
        "requiredTestLayers": [
          "unit"
        ]
      },
      "verification": {
        "check": {
          "kind": "tests",
          "files": [
            "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts"
          ]
        },
        "method": "Use the named maintained test files and exact cases matching the controls below. Read ledger-backed evidence and compare source/test/runtime fingerprints before deciding whether fresh execution is necessary. A test's existence or this draft's syntactic validity is not a passing observation. Do not re-run terminal proof or an expensive current R12 case for recall.",
        "controls": [
          "before/at reset",
          "same account/model/owner/carry",
          "expiry consumed once"
        ]
      },
      "status": "DRAFT_NOT_REGISTERED",
      "unresolved": []
    },
    {
      "draftId": "F98-19C",
      "fromFire97Prototype": "R-19",
      "planItems": [
        "P-004",
        "P-012"
      ],
      "sourceDecisions": [
        "D-014"
      ],
      "provenance": "derived from existing owner-backed plan item and governing decision; not a newly asserted owner directive",
      "intent": {
        "request": "A latched Codex quota wall permits one deferred wake when its bounded backoff probe becomes due.",
        "sourceRefs": [
          "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20",
          "plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-014"
        ]
      },
      "acceptance": {
        "condition": "A latched Codex quota wall permits one deferred wake when its bounded backoff probe becomes due.",
        "falsifier": "An early top-up cannot be discovered before the stated reset or more than one wake bypasses the same probe interval.",
        "evidencePlane": "tree",
        "requiredScope": [
          "apps/operator/scripts/psu-pty-host.mjs"
        ],
        "requiredTestLayers": [
          "unit"
        ]
      },
      "verification": {
        "check": {
          "kind": "tests",
          "files": [
            "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts"
          ]
        },
        "method": "Use the named maintained test files and exact cases matching the controls below. Read ledger-backed evidence and compare source/test/runtime fingerprints before deciding whether fresh execution is necessary. A test's existence or this draft's syntactic validity is not a passing observation. Do not re-run terminal proof or an expensive current R12 case for recall.",
        "controls": [
          "initial interval",
          "one deferred wake",
          "backoff progression",
          "early capacity return",
          "non-Codex control"
        ]
      },
      "status": "DRAFT_NOT_REGISTERED",
      "unresolved": []
    },
    {
      "draftId": "F98-19D",
      "fromFire97Prototype": "R-19",
      "planItems": [
        "P-004",
        "P-012"
      ],
      "sourceDecisions": [
        "D-013",
        "D-014"
      ],
      "provenance": "derived from existing owner-backed plan item and governing decision; not a newly asserted owner directive",
      "intent": {
        "request": "A still-walled Codex probe re-establishes the quota latch from its current provider response.",
        "sourceRefs": [
          "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20",
          "plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-013",
          "plan:parked-agent-census-resumption-and-root-cause-2026-10-09#D-014"
        ]
      },
      "acceptance": {
        "condition": "A still-walled Codex probe re-establishes the quota latch from its current provider response.",
        "falsifier": "The failed probe leaves unlimited wake admission or retains an obsolete reset instead of re-latching.",
        "evidencePlane": "tree",
        "requiredScope": [
          "apps/operator/scripts/psu-pty-host.mjs"
        ],
        "requiredTestLayers": [
          "unit"
        ]
      },
      "verification": {
        "check": {
          "kind": "tests",
          "files": [
            "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts"
          ]
        },
        "method": "Use the named maintained test files and exact cases matching the controls below. Read ledger-backed evidence and compare source/test/runtime fingerprints before deciding whether fresh execution is necessary. A test's existence or this draft's syntactic validity is not a passing observation. Do not re-run terminal proof or an expensive current R12 case for recall.",
        "controls": [
          "new provider reset",
          "banner repaint",
          "bounded subsequent probe",
          "new episode resets base interval",
          "D014 withdrawal of blanket default-route prohibition"
        ]
      },
      "status": "DRAFT_NOT_REGISTERED",
      "unresolved": []
    },
    {
      "draftId": "F98-20A",
      "fromFire97Prototype": "R-20",
      "planItems": [
        "P-008"
      ],
      "sourceDecisions": [],
      "provenance": "derived from existing owner-backed plan item and governing decision; not a newly asserted owner directive",
      "intent": {
        "request": "Rendered fleet-scope-admission guidance reserves loop:end for a legitimate completion or stop.",
        "sourceRefs": [
          "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20"
        ]
      },
      "acceptance": {
        "condition": "Rendered fleet-scope-admission guidance reserves loop:end for a legitimate completion or stop.",
        "falsifier": "A rendered external-blocker branch instructs an agent with retained unfinished obligations to call loop:end.",
        "evidencePlane": "tree",
        "requiredScope": [
          "packages/operator-core/lib/scheduler/fleet-scope-admission.ts"
        ],
        "requiredTestLayers": [
          "unit",
          "llm"
        ]
      },
      "verification": {
        "check": {
          "kind": "tests",
          "files": [
            "packages/operator-core/lib/scheduler/fleet-scope-admission.test.ts",
            "packages/operator-core/lib/scheduler/fleet-scope-admission.recovery.test.ts"
          ]
        },
        "method": "Use the named maintained test files and exact cases matching the controls below. Read ledger-backed evidence and compare source/test/runtime fingerprints before deciding whether fresh execution is necessary. A test's existence or this draft's syntactic validity is not a passing observation. Do not re-run terminal proof or an expensive current R12 case for recall.",
        "controls": [
          "fourth producer rendered seam",
          "done/released/handed-off/owner-stop controls",
          "maintained su LLM receipt at current render"
        ]
      },
      "status": "DRAFT_NOT_REGISTERED",
      "unresolved": []
    },
    {
      "draftId": "F98-20B",
      "fromFire97Prototype": "R-20",
      "planItems": [
        "P-008"
      ],
      "sourceDecisions": [],
      "provenance": "derived from existing owner-backed plan item and governing decision; not a newly asserted owner directive",
      "intent": {
        "request": "Rendered fleet-scope-admission guidance directs a partially blocked agent to continue its independent work.",
        "sourceRefs": [
          "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20"
        ]
      },
      "acceptance": {
        "condition": "Rendered fleet-scope-admission guidance directs a partially blocked agent to continue its independent work.",
        "falsifier": "A partial blocker makes the rendered guidance direct whole-task parking before independent work is exhausted.",
        "evidencePlane": "tree",
        "requiredScope": [
          "packages/operator-core/lib/scheduler/fleet-scope-admission.ts"
        ],
        "requiredTestLayers": [
          "unit",
          "llm"
        ]
      },
      "verification": {
        "check": {
          "kind": "tests",
          "files": [
            "packages/operator-core/lib/scheduler/fleet-scope-admission.test.ts",
            "packages/operator-core/lib/scheduler/fleet-scope-admission.recovery.test.ts"
          ]
        },
        "method": "Use the named maintained test files and exact cases matching the controls below. Read ledger-backed evidence and compare source/test/runtime fingerprints before deciding whether fresh execution is necessary. A test's existence or this draft's syntactic validity is not a passing observation. Do not re-run terminal proof or an expensive current R12 case for recall.",
        "controls": [
          "independent step remains",
          "all remaining steps genuinely blocked control",
          "maintained su LLM receipt"
        ]
      },
      "status": "DRAFT_NOT_REGISTERED",
      "unresolved": []
    },
    {
      "draftId": "F98-20C",
      "fromFire97Prototype": "R-20",
      "planItems": [
        "P-008"
      ],
      "sourceDecisions": [],
      "provenance": "derived from existing owner-backed plan item and governing decision; not a newly asserted owner directive",
      "intent": {
        "request": "Rendered fleet-scope-admission guidance gives a fully blocked agent a bounded wake on its specific unblocking event.",
        "sourceRefs": [
          "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20"
        ]
      },
      "acceptance": {
        "condition": "Rendered fleet-scope-admission guidance gives a fully blocked agent a bounded wake on its specific unblocking event.",
        "falsifier": "The rendered advice uses an untimed generic watch, a self-deadlocking held-item done event, or no wake-on-timeout bound.",
        "evidencePlane": "tree",
        "requiredScope": [
          "packages/operator-core/lib/scheduler/fleet-scope-admission.ts"
        ],
        "requiredTestLayers": [
          "unit",
          "llm"
        ]
      },
      "verification": {
        "check": {
          "kind": "tests",
          "files": [
            "packages/operator-core/lib/scheduler/fleet-scope-admission.test.ts",
            "packages/operator-core/lib/scheduler/fleet-scope-admission.recovery.test.ts"
          ]
        },
        "method": "Use the named maintained test files and exact cases matching the controls below. Read ledger-backed evidence and compare source/test/runtime fingerprints before deciding whether fresh execution is necessary. A test's existence or this draft's syntactic validity is not a passing observation. Do not re-run terminal proof or an expensive current R12 case for recall.",
        "controls": [
          "record actual typed blocker",
          "exact event key",
          "on_timeout wake and bound",
          "no held-item done self-deadlock",
          "maintained su LLM receipt"
        ]
      },
      "status": "DRAFT_NOT_REGISTERED",
      "unresolved": []
    }
  ],
  "designDischargeMap": [
    {
      "draftId": "F98-15A",
      "items": [
        "P-011"
      ],
      "evidencePlane": "live"
    },
    {
      "draftId": "F98-15B",
      "items": [
        "P-011"
      ],
      "evidencePlane": "live"
    },
    {
      "draftId": "F98-15C",
      "items": [
        "P-011"
      ],
      "evidencePlane": "live"
    },
    {
      "draftId": "F98-15D",
      "items": [
        "P-011"
      ],
      "evidencePlane": "live"
    },
    {
      "draftId": "F98-15E",
      "items": [
        "P-011"
      ],
      "evidencePlane": "live"
    },
    {
      "draftId": "F98-16",
      "items": [
        "P-013"
      ],
      "evidencePlane": "live"
    },
    {
      "draftId": "F98-17",
      "items": [
        "P-013"
      ],
      "evidencePlane": "live"
    },
    {
      "draftId": "F98-18A",
      "items": [
        "P-007",
        "P-013"
      ],
      "evidencePlane": "tree"
    },
    {
      "draftId": "F98-18B",
      "items": [
        "P-007"
      ],
      "evidencePlane": "tree"
    },
    {
      "draftId": "F98-18C",
      "items": [
        "P-007"
      ],
      "evidencePlane": "tree"
    },
    {
      "draftId": "F98-18D",
      "items": [
        "P-007"
      ],
      "evidencePlane": "tree"
    },
    {
      "draftId": "F98-18E",
      "items": [
        "P-007"
      ],
      "evidencePlane": "tree"
    },
    {
      "draftId": "F98-18F",
      "items": [
        "P-007"
      ],
      "evidencePlane": "tree"
    },
    {
      "draftId": "F98-19A",
      "items": [
        "P-004",
        "P-012"
      ],
      "evidencePlane": "tree"
    },
    {
      "draftId": "F98-19B",
      "items": [
        "P-004",
        "P-012"
      ],
      "evidencePlane": "tree"
    },
    {
      "draftId": "F98-19C",
      "items": [
        "P-004",
        "P-012"
      ],
      "evidencePlane": "tree"
    },
    {
      "draftId": "F98-19D",
      "items": [
        "P-004",
        "P-012"
      ],
      "evidencePlane": "tree"
    },
    {
      "draftId": "F98-20A",
      "items": [
        "P-008"
      ],
      "evidencePlane": "tree"
    },
    {
      "draftId": "F98-20B",
      "items": [
        "P-008"
      ],
      "evidencePlane": "tree"
    },
    {
      "draftId": "F98-20C",
      "items": [
        "P-008"
      ],
      "evidencePlane": "tree"
    }
  ],
  "unresolved": [
    "Outside-lineage review and actual Requirements/Design mapping precede any application.",
    "F98-17 requires the pending owner near-zero interpretation.",
    "F98-16 requires the exact baseline selector; missing input is unknown.",
    "Named check paths and exact cases must be verified; this draft is not a test execution.",
    "P004 auth-rotation causal hazard still needs a source-backed disposition; these six supplements do not silently discharge it.",
    "Historical R13 eligibility/scope remains owner-pending; no historical searches resumed.",
    "R12 expensive runtime retry remains gated by actual upstream clean preflight.",
    "R14 has no final all-fix runtime anchor and actual24h is unstarted.",
    "Current fourth guidance producer has a suspected behavior/guard defect; source investigation and owned registration follow."
  ],
  "boundaries": {
    "testsRun": false,
    "cardsEmitted": false,
    "planModified": false,
    "rubricModified": false,
    "originalLoop844090": "frozen verified; no replay",
    "LIVE_GATE_OPS": false
  },
  "maintenanceFriction": [
    {
      "ref": "EI-26124669550358109",
      "kind": "probation observation",
      "note": "default ptool generation refusal; exact identity verified through direct invoke"
    },
    {
      "ref": "EI-25971794946215909",
      "kind": "coalesced observation",
      "note": "artifacts max_chars caller cap; use pages <=20000"
    },
    {
      "ref": "conv-mvaq3kyy-0000-a6054df3901c4a78bc2b75440a3a1b8a",
      "kind": "retrieval-only consult",
      "result": "no qualified responder; no pending answer or await"
    }
  ],
  "referenceVerification": {
    "source": "canonical staging tree; paths read before persistence",
    "existingTestFiles": 8,
    "removedInventedPath": "packages/operator-core/lib/agent-tools/coordination/parked-agent-census.e2e.test.ts",
    "replacement": "original R14 {kind:instrument,instrumentKey:parked-agent-census}",
    "proofClaims": "none; existing test files are proposed checks, not verified coverage",
    "newFinding": "Current fleet-scope-admission advice still tells retained blocked-work holders to call loop:end and defers their wake to refusal.recovery.steps; see source HELD_BLOCKED_ITEM_STAYS_HELD and test named P-008 release remaining lane resources. This requires an owned source investigation, not a claim of passing coverage."
  }
}
