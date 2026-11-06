---
rel_path: "runtime-migration/p006-d019-start-refusal-0dcd3-20261106.json"
updated_at: 1793938076463
_body: "content"
---

{
  "schemaVersion": 1,
  "status": "TERMINAL_CANONICAL_START_REFUSAL_NO_DIAGNOSTIC_LAUNCHED",
  "plan": "node-to-bun-staged-migration-2026-10-22",
  "workItem": "WI-6554700010022072",
  "decision": "D-019",
  "audit": {
    "auditSeq": 15,
    "auditedPlanRevision": {
      "id": 84909,
      "seq": 57,
      "contentHash": "af2aa1ded67bf168291f875b5ba74bceda3bafa932fab2f8d52ea67ed424975f"
    },
    "sourceRanges": 2,
    "carriedMappings": [
      "M-001",
      "M-002"
    ],
    "sourceRefsResolved": 2,
    "unresolvedItemProvenance": 0
  },
  "proposal": "runtime-migration/p006-post-safety-20fee-proposal-0dcd3-20261106.json",
  "canonicalStartResult": {
    "ok": false,
    "results": [
      {
        "ok": false,
        "slug": "node-to-bun-staged-migration-2026-10-22",
        "harnessSlug": "papercusp",
        "error": "spec_quality_not_current",
        "satisfied": false,
        "applicable": true,
        "mode": "enforced",
        "planSlug": "node-to-bun-staged-migration-2026-10-22",
        "specSetHash": "d8d0de8331cd329204fcc90b244545fef16179ae30168e481a7987aa8d653a40",
        "classRef": "plan-class-migration",
        "code": "spec_quality_scorecard_missing",
        "wouldBlock": [
          "exact-specSetHash-scorecard-missing"
        ],
        "candidates": [
          {
            "classRef": "plan-class-migration",
            "verdict": "pass",
            "wouldBlock": [],
            "subjectRef": "spec-set:plan-class-migration:d8d0de8331cd329204fcc90b244545fef16179ae30168e481a7987aa8d653a40:3bf31049db04120e"
          }
        ],
        "message": "Plan 'node-to-bun-staged-migration-2026-10-22' has structurally passing clauses but no current complete terminal spec-quality scorecard for exact specSetHash d8d0de8331cd329204fcc90b244545fef16179ae30168e481a7987aa8d653a40 under persisted class plan-class-migration. Run plans:evaluate-spec-quality { slug:'node-to-bun-staged-migration-2026-10-22', classRef:'plan-class-migration' }, emit its scorecardDraft through scorecards:emit, then retry. Any clause revision changes the hash and invalidates older cards."
      }
    ],
    "counts": {
      "ok": 0,
      "failed": 1
    }
  },
  "execution": {
    "nativeCommandSubmitted": false,
    "generationRead": false,
    "leaseAcquired": false,
    "diagnosticExecuted": false,
    "sourceEdited": false,
    "testsRun": false
  },
  "disposition": "D019 cannot execute because ordinary canonical plans:start refused. No retry/fallback/retarget or post-refusal generation probe. Retain exact original tuple and proposal. Fresh prerequisite repair and distinct coordinator disposition/current audit/start needed before any later diagnostic.",
  "knownNextDependency": "Current exact spec-quality terminal scorecard absent for d8d0de8331cd329204fcc90b244545fef16179ae30168e481a7987aa8d653a40 under plan-class-migration. Structural candidate pass alone is insufficient; preserve evaluator/grader provenance."
}
