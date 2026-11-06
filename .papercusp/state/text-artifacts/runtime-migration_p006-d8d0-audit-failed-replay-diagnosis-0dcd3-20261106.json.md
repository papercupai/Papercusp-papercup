---
rel_path: "runtime-migration/p006-d8d0-audit-failed-replay-diagnosis-0dcd3-20261106.json"
updated_at: 1793941638152
_body: "content"
---

{
  "schemaVersion": "bun-p006-failed-independent-audit-diagnosis-v1",
  "ownerId": "su-0dcd3a3c-a45f-482b-a8cd-e957407353f9",
  "plan": "node-to-bun-staged-migration-2026-10-22",
  "workItem": "WI-6554700010022072",
  "targetCard": "EI-28010179012065277",
  "auditCard": "EI-28013353279763854",
  "auditor": "su-011669fa-febe-4a52-adcf-2feee5ac08a4",
  "result": "failed",
  "auditCriteriaComplete": true,
  "criteria": [
    {
      "key": "base-rate-check",
      "rating": "pass",
      "evidence": "Read all eight exact criterion strings using scorecards:get {issueId:'EI-28010179012065277',criterionKey:<each indexed key>,evidenceOffset:0}; each reached evidenceRead.complete=true, fingerprint 2513feceb6a63aed3027ecd826092474a95ff97436ff594170be711cf55f8258. There are no downgrade ratings, hence no missing downgrade satisfiability showing. The positive claims name 27 accepted clauses, coverage of 8 items, a migration-data-integrity clause and the exact set identity. plans:get-specs {slug:'node-to-bun-staged-migration-2026-10-22',harness:'papercusp',asOf:'2026-11-06T04:09:48.310Z',payloadTier:'full'} returned 27 active rows, all with contentHash/acceptedBy/acceptanceRef and revision=currentRevision, spanning P-001 through P-008; rollback-data is migration-data-integrity. The implementation-independence absence statement is a prohibition scoped to all active clauses, not a zero-act positive-duty pass. Exact set reproduction remains a separate unresolved limitation."
    },
    {
      "key": "instrument-split",
      "rating": "pass",
      "evidence": "Every target criterion explicitly selects plans:get-specs {slug:'node-to-bun-staged-migration-2026-10-22',harness:'papercusp'} and plans:evaluate-spec-quality with that slug/harness, classRef:'plan-class-migration', expectedSpecSetHash:'d8d0de8331cd329204fcc90b244545fef16179ae30168e481a7987aa8d653a40'. These are the canonical clause/plan quality stores for identity, item ownership, clause behavior, exemptions, class and set identity. Historical plans:get-specs at the card creation cutoff returned 27 clause rows and their provenance. No MCP/native activity or cost is inferred from these stores. The exact evaluator returned spec_set_hash_mismatch, an explicit scope guard rather than evidence from a wrong instrument; this prevents historical verdict reproduction and is recorded below."
    },
    {
      "key": "terminal-re-rate",
      "rating": "pass",
      "evidence": "scorecards:list {rubricRef:'spec-quality',subjectRef:'spec-set:plan-class-migration:d8d0de8331cd329204fcc90b244545fef16179ae30168e481a7987aa8d653a40:3bf31049db04120e',provisional:true} returned count:0, hasMore:false, scorecards:[]. No interim exists for this exact subject to have been frozen into the terminal card. This is a clause-set snapshot, not a duration/activity verdict; every criterion names the same expectedSpecSetHash. No evidence window ending at an interim was found. This does not establish that the exact historical hash can be reproduced."
    },
    {
      "key": "platform-telemetry-excluded",
      "rating": "pass",
      "evidence": "Inspected all eight stored criteria and spec-quality revision 6. None measures efficiency, activity mix, tool-invocation frequency, cost, or session modes. Their counts are 27 spec clauses and 8 plan items from the clause/plan stores. No platform hook, wake, watchdog, or tools:invoke-wrapper traffic enters those populations, so there is no efficiency/activity query requiring telemetry predicates."
    },
    {
      "key": "re-runnable-evidence",
      "rating": "fail",
      "evidence": "All-pass coverage was applied to every applicable key: stable-revision-identity, item-contract-coverage, atomic-observable-behavior, falsifiability, implementation-independence, plan-class-specialization, spec-set-freshness. All seven and N/A explicit-non-behavioral-exemptions share this exact probe, executed once and compared for every key: plans:evaluate-spec-quality {slug:'node-to-bun-staged-migration-2026-10-22',harness:'papercusp',classRef:'plan-class-migration',expectedSpecSetHash:'d8d0de8331cd329204fcc90b244545fef16179ae30168e481a7987aa8d653a40'}. It returned ok:false,error:'spec_set_hash_mismatch', selected hash 57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186, no ratings. This is a successful refusal of another scope, not a transport failure or proof the original behaviors fail. The full target work_items:get {id:'EI-28010179012065277',payloadTier:'full'} observation contains no rerunRecipe or historical planContentHash/clausesAsOf replay inputs; the complete eight evidence strings supply neither. Exact-hash reproduction is therefore not available from the stored recipe; a historical replay would require unstated selection inputs. Independent N/A check: plans:get-specs with the same slug/harness, asOf:'2026-11-06T04:09:48.310Z',payloadTier:'full', fully recovered all 40,297 spill bytes and 27 rows: all lifecycleStatus:'active', none exempt, all exemption:null, all behavioral classes. This supports the N/A basis but does not demonstrate that reconstructed cutoff hashes to the original subject. No binding or committed-file citation is involved.",
      "evidenceRef": "plans:evaluate-spec-quality {slug:'node-to-bun-staged-migration-2026-10-22',harness:'papercusp',classRef:'plan-class-migration',expectedSpecSetHash:'d8d0de8331cd329204fcc90b244545fef16179ae30168e481a7987aa8d653a40'}",
      "evidenceKind": "tool-result"
    },
    {
      "key": "degenerate-distribution",
      "rating": "unknown",
      "evidence": "Persisted histogram is pass:7, not-applicable:1. After independently checking the N/A basis against all 27 historical clause rows, applicable histogram is pass:7 (7/7 uniform); no waived/downgrade ratings. Attempted the common exact evaluator probe for all seven keys listed in re-runnable-evidence. It refused with spec_set_hash_mismatch (expected d8d0de8331cd329204fcc90b244545fef16179ae30168e481a7987aa8d653a40; selected 57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186) and yielded no criterion values. Thus the mandated complete rechecks cannot corroborate the uniform verdict. There is no verified contradictory result for the original set, so uniformity is unresolved, not itself a semantic failure. No global gates:degenerate-check log was substituted.",
      "unknownReason": "scope-mismatch"
    }
  ],
  "distinguishingReads": {
    "default": {
      "ok": false,
      "error": "spec_set_hash_mismatch",
      "specSetHash": "57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186",
      "expectedSpecSetHash": "d8d0de8331cd329204fcc90b244545fef16179ae30168e481a7987aa8d653a40",
      "blockers": [
        {
          "check": "clauses",
          "state": "blocked",
          "code": "spec_set_hash_mismatch",
          "message": "Expected specSetHash d8d0de8331cd329204fcc90b244545fef16179ae30168e481a7987aa8d653a40, but the selected clauses hash to 57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186; refusing a different clause set."
        }
      ],
      "wouldBlock": [
        "spec_set_hash_mismatch"
      ]
    },
    "staging3170": {
      "ok": false,
      "error": "spec_set_hash_mismatch",
      "specSetHash": "57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186",
      "expectedSpecSetHash": "d8d0de8331cd329204fcc90b244545fef16179ae30168e481a7987aa8d653a40",
      "blockers": [
        {
          "check": "clauses",
          "state": "blocked",
          "code": "spec_set_hash_mismatch",
          "message": "Expected specSetHash d8d0de8331cd329204fcc90b244545fef16179ae30168e481a7987aa8d653a40, but the selected clauses hash to 57ebd1090f32f489cd6465502c56ee339cfe45715b3ccb7e2212ab8ad7899186; refusing a different clause set."
        }
      ],
      "wouldBlock": [
        "spec_set_hash_mismatch"
      ]
    }
  },
  "originalArtifacts": [
    "runtime-migration/p006-d019-current-spec-quality-evaluation-0dcd3-20261106.json",
    "runtime-migration/p006-d019-current-spec-quality-card-0dcd3-20261106.json"
  ],
  "sourceReads": {
    "evaluator": "packages/operator-core/lib/agent-tools/plans/evaluate-spec-quality.ts",
    "identity": "packages/operator-core/lib/agent-tools/plans/spec-quality-identity.ts",
    "hashWriter": "packages/operator-core/lib/agent-tools/plans/spec-clause-compiler.ts:312",
    "observations": [
      "Current source hash protocol constant is2; comment says v1 omitted declared falsifiers. This is not yet a measured cause of the original differing hashes.",
      "Current source adds historical replaySnapshot and evaluatorBuild/hash-protocol binding; current3170 schema exposes replaySnapshot but not evaluatorBuild/specSetHashVersion.",
      "Original saved draft has no immutable historical recipe; do not silently revise it or selfaudit."
    ]
  },
  "incompleteRead": {
    "tool": "plans:evaluate-spec-quality",
    "route": "http://127.0.0.1:3170",
    "args": {
      "harness": "papercusp",
      "slug": "node-to-bun-staged-migration-2026-10-22",
      "classRef": "plan-class-migration"
    },
    "reason": "Full native output exceeded max_output_tokens, so JSON parse failed. Visible output names57eb/pass and replaySnapshot af2aa1de/cutoff2026-10-23T19:18:53.760Z, but complete draft was NOT recovered and MUST NOT be emitted.",
    "next": "Re-read with projection limiting summary identity/replay/recipe/rating keys; capture full draft directly to canonical artifact or bounded source output before emission."
  },
  "remaining": [
    "Establish actual cause of d8d0-vs57eb using hash writer/version and exact selected immutable rows; do not infer from current source alone.",
    "Recover current evaluation with bounded read and verify exact immutable replay on a compatible current runtime.",
    "Find existing registered repair ownership for evaluator/hash binding before any source change; reuse current surfaces/tests.",
    "Only emit a distinct corrected evaluator-authored card with complete immutable replay evidence, through canonical emission/router. No duplicate of old failed card/selfaudit.",
    "After actual independent PASS obtain distinct coordinator diagnostic admission/current activation audit/canonical start. D011-D019 remain terminal; no native diagnostic/lease/generation read/source edit/test this turn."
  ]
}
