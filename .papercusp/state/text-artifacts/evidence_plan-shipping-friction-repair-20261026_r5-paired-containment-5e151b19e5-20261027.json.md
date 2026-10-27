---
rel_path: "evidence/plan-shipping-friction-repair-20261026/r5-paired-containment-5e151b19e5-20261027.json"
updated_at: 1793087972034
_body: "content"
---

{
  "schemaVersion": 1,
  "kind": "operational-test-evidence",
  "subject": {
    "plan": "plan-shipping-friction-repair-2026-10-26",
    "specId": "AUTO-BAR-R-5-P-001",
    "revision": 3,
    "workItemId": "WI-9999934"
  },
  "recordedAt": "2026-10-27T07:59:26.811Z",
  "result": "pass",
  "scope": "six declared source files; current-build containment and phase-specific refusal only",
  "observations": [
    {
      "path": "packages/operator-core/lib/plan-acceptance-gate.ts",
      "servingRuntimes": [
        {
          "runtime": "release-operator",
          "role": "owner",
          "buildSha": "d740fc3802",
          "buildShaSource": "health",
          "containsChange": false,
          "method": "blob",
          "instances": null,
          "unknownReason": null
        },
        {
          "runtime": "staging-operator",
          "role": "owner",
          "buildSha": "5e151b19e5",
          "buildShaSource": "health",
          "containsChange": true,
          "method": "blob",
          "instances": null,
          "unknownReason": null
        },
        {
          "runtime": "bg-host",
          "role": "shared",
          "buildSha": "bf1055224b",
          "buildShaSource": "health",
          "containsChange": true,
          "method": "blob",
          "instances": null,
          "unknownReason": null
        },
        {
          "runtime": "gateway",
          "role": "shared",
          "buildSha": "26b7b5ee75",
          "buildShaSource": "runtime-vintage",
          "containsChange": true,
          "method": "blob",
          "instances": null,
          "unknownReason": null
        }
      ]
    },
    {
      "path": "packages/operator-core/lib/rubrics.ts",
      "servingRuntimes": [
        {
          "runtime": "release-operator",
          "role": "owner",
          "buildSha": "d740fc3802",
          "buildShaSource": "health",
          "containsChange": false,
          "method": "blob",
          "instances": null,
          "unknownReason": null
        },
        {
          "runtime": "staging-operator",
          "role": "owner",
          "buildSha": "5e151b19e5",
          "buildShaSource": "health",
          "containsChange": true,
          "method": "blob",
          "instances": null,
          "unknownReason": null
        },
        {
          "runtime": "bg-host",
          "role": "shared",
          "buildSha": "bf1055224b",
          "buildShaSource": "health",
          "containsChange": true,
          "method": "blob",
          "instances": null,
          "unknownReason": null
        },
        {
          "runtime": "gateway",
          "role": "shared",
          "buildSha": "26b7b5ee75",
          "buildShaSource": "runtime-vintage",
          "containsChange": true,
          "method": "blob",
          "instances": null,
          "unknownReason": null
        }
      ]
    },
    {
      "path": "packages/operator-core/lib/acceptance-bar-lifecycle-evaluator.ts",
      "servingRuntimes": [
        {
          "runtime": "release-operator",
          "role": "owner",
          "buildSha": "d740fc3802",
          "buildShaSource": "health",
          "containsChange": false,
          "method": "blob",
          "instances": null,
          "unknownReason": null
        },
        {
          "runtime": "staging-operator",
          "role": "owner",
          "buildSha": "5e151b19e5",
          "buildShaSource": "health",
          "containsChange": true,
          "method": "blob",
          "instances": null,
          "unknownReason": null
        },
        {
          "runtime": "bg-host",
          "role": "shared",
          "buildSha": "bf1055224b",
          "buildShaSource": "health",
          "containsChange": true,
          "method": "blob",
          "instances": null,
          "unknownReason": null
        },
        {
          "runtime": "gateway",
          "role": "shared",
          "buildSha": "26b7b5ee75",
          "buildShaSource": "runtime-vintage",
          "containsChange": true,
          "method": "blob",
          "instances": null,
          "unknownReason": null
        }
      ]
    },
    {
      "path": "packages/operator-core/lib/agent-tools/plans/acceptance-drain-filing.ts",
      "servingRuntimes": [
        {
          "runtime": "release-operator",
          "role": "owner",
          "buildSha": "d740fc3802",
          "buildShaSource": "health",
          "containsChange": false,
          "method": "blob",
          "instances": null,
          "unknownReason": null
        },
        {
          "runtime": "staging-operator",
          "role": "owner",
          "buildSha": "5e151b19e5",
          "buildShaSource": "health",
          "containsChange": true,
          "method": "blob",
          "instances": null,
          "unknownReason": null
        },
        {
          "runtime": "bg-host",
          "role": "shared",
          "buildSha": "bf1055224b",
          "buildShaSource": "health",
          "containsChange": true,
          "method": "blob",
          "instances": null,
          "unknownReason": null
        },
        {
          "runtime": "gateway",
          "role": "shared",
          "buildSha": "26b7b5ee75",
          "buildShaSource": "runtime-vintage",
          "containsChange": true,
          "method": "blob",
          "instances": null,
          "unknownReason": null
        }
      ]
    },
    {
      "path": "packages/operator-core/lib/plan-items/plan-drain-rule.ts",
      "servingRuntimes": [
        {
          "runtime": "release-operator",
          "role": "owner",
          "buildSha": "d740fc3802",
          "buildShaSource": "health",
          "containsChange": false,
          "method": "blob",
          "instances": null,
          "unknownReason": null
        },
        {
          "runtime": "staging-operator",
          "role": "owner",
          "buildSha": "5e151b19e5",
          "buildShaSource": "health",
          "containsChange": true,
          "method": "blob",
          "instances": null,
          "unknownReason": null
        },
        {
          "runtime": "bg-host",
          "role": "shared",
          "buildSha": "bf1055224b",
          "buildShaSource": "health",
          "containsChange": true,
          "method": "blob",
          "instances": null,
          "unknownReason": null
        },
        {
          "runtime": "gateway",
          "role": "shared",
          "buildSha": "26b7b5ee75",
          "buildShaSource": "runtime-vintage",
          "containsChange": true,
          "method": "blob",
          "instances": null,
          "unknownReason": null
        }
      ]
    },
    {
      "path": "packages/operator-core/lib/events/builtin-actions.ts",
      "servingRuntimes": [
        {
          "runtime": "release-operator",
          "role": "owner",
          "buildSha": "d740fc3802",
          "buildShaSource": "health",
          "containsChange": false,
          "method": "blob",
          "instances": null,
          "unknownReason": null
        },
        {
          "runtime": "staging-operator",
          "role": "owner",
          "buildSha": "5e151b19e5",
          "buildShaSource": "health",
          "containsChange": true,
          "method": "blob",
          "instances": null,
          "unknownReason": null
        },
        {
          "runtime": "bg-host",
          "role": "shared",
          "buildSha": "bf1055224b",
          "buildShaSource": "health",
          "containsChange": true,
          "method": "blob",
          "instances": null,
          "unknownReason": null
        },
        {
          "runtime": "gateway",
          "role": "shared",
          "buildSha": "26b7b5ee75",
          "buildShaSource": "runtime-vintage",
          "containsChange": true,
          "method": "blob",
          "instances": null,
          "unknownReason": null
        }
      ]
    }
  ],
  "positiveControl": {
    "runtime": "staging-operator",
    "buildSha": "5e151b19e5",
    "expectedContainsChange": true
  },
  "negativeControl": {
    "runtime": "release-operator",
    "buildSha": "d740fc3802",
    "expectedContainsChange": false
  },
  "readiness": {
    "buildProvenance": {
      "sha": "5e151b19e5",
      "version": "0.0.0"
    },
    "satisfied": false,
    "skipped": null,
    "code": "acceptance_bar_contract_not_ready",
    "message": "BLOCKED AT PRE-GRADING (5 code(s): bar_snapshot_proof_inadequate, bar_snapshot_evidence_plane_unmet, bar_snapshot_proof_missing, bar_snapshot_proof_stale, bar_snapshot_evidence_runtime_unmet). NEXT REPAIR (R-11): Bind evidence at the current spec revision on the declared evidence plane.. Grading and author-verdict codes in the ship list cannot be worked until this phase passes.\nacceptance BAR contract is not ready for ship — 13 of 13 BAR(s) blocking, 0 clean: R-1: bar_snapshot_proof_inadequate, bar_snapshot_grading_missing; R-10: bar_snapshot_grading_missing; R-11: bar_snapshot_proof_missing, bar_snapshot_evidence_plane_unmet, bar_snapshot_evidence_runtime_unmet, bar_snapshot_grading_missing; R-12: bar_snapshot_proof_inadequate, bar_snapshot_grading_missing; R-13: bar_snapshot_grading_missing; R-2: bar_snapshot_grading_missing; R-3: bar_snapshot_grading_missing; R-4: bar_snapshot_proof_stale, bar_snapshot_evidence_plane_unmet, bar_snapshot_evidence_runtime_unmet, bar_snapshot_grading_missing; R-5: bar_snapshot_proof_stale, bar_snapshot_evidence_plane_unmet, bar_snapshot_evidence_runtime_unmet, bar_snapshot_grading_missing; R-6: bar_snapshot_grading_missing; R-7: bar_snapshot_grading_missing; R-8: bar_snapshot_grading_missing; R-9: bar_snapshot_grading_missing; contract-level: bar_snapshot_author_verdict_missing\nNEXT REPAIR (R-11, bar_snapshot_proof_missing): Bind evidence at the current spec revision on the declared evidence plane.\nThis refusal does NOT recruit a grader: grader recruitment fires only on acceptance_ungraded / self_graded_only through plans:set-plan-status. Repair the blocking pre-grading obligations first; then retry plans:set-plan-status with status shipped to use its independent grader routing. A missing or stale independent grading is grader work; record the author verdict after reading that grading. Never self-grade or launch a parallel reviewer.",
    "repairAction": {
      "kind": "diagnostic",
      "nextVerb": {
        "name": "plans:get",
        "args": {
          "slug": "plan-shipping-friction-repair-2026-10-26",
          "harness": "papercusp",
          "mode": "meta",
          "shipReadiness": true
        }
      },
      "instruction": "Bind evidence at the current spec revision on the declared evidence plane."
    }
  },
  "disclosures": [
    "The plan remains blocked at pre-grading; no independent final acceptance or shipment is claimed.",
    "Independent fixture-calibration audit has not approved this new paired operational evidence; EI-27085073258221362 remains the existing auditor issue.",
    "WI-9999934 retains its explicit deployed-only external blocker."
  ]
}
