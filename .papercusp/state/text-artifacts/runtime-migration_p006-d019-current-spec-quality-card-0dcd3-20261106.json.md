---
rel_path: "runtime-migration/p006-d019-current-spec-quality-card-0dcd3-20261106.json"
updated_at: 1793938188476
_body: "content"
---

{
  "evaluation": "runtime-migration/p006-d019-current-spec-quality-evaluation-0dcd3-20261106.json",
  "specSetHash": "d8d0de8331cd329204fcc90b244545fef16179ae30168e481a7987aa8d653a40",
  "draft": {
    "rubricRef": "spec-quality",
    "subject": {
      "kind": "plan",
      "ref": "spec-set:plan-class-migration:d8d0de8331cd329204fcc90b244545fef16179ae30168e481a7987aa8d653a40:3bf31049db04120e"
    },
    "title": "node-to-bun-staged-migration-2026-10-22 spec quality (plan-class-migration)",
    "body": "Plan node-to-bun-staged-migration-2026-10-22; class plan-class-migration; exact current specSetHash d8d0de8331cd329204fcc90b244545fef16179ae30168e481a7987aa8d653a40; 27 current clause(s), 8 plan item(s).",
    "ratings": {
      "stable-revision-identity": {
        "rating": "pass",
        "evidence": "Source store: plans:get-specs { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\" }. Re-run exactly: plans:evaluate-spec-quality { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\", classRef:\"plan-class-migration\", expectedSpecSetHash:\"d8d0de8331cd329204fcc90b244545fef16179ae30168e481a7987aa8d653a40\" }; confirm the returned specSetHash equals \"d8d0de8331cd329204fcc90b244545fef16179ae30168e481a7987aa8d653a40\"; inspect ratings[\"stable-revision-identity\"]. 27 current clause(s) have unique identities, content hashes, and acceptance provenance."
      },
      "item-contract-coverage": {
        "rating": "pass",
        "evidence": "Source store: plans:get-specs { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\" }. Re-run exactly: plans:evaluate-spec-quality { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\", classRef:\"plan-class-migration\", expectedSpecSetHash:\"d8d0de8331cd329204fcc90b244545fef16179ae30168e481a7987aa8d653a40\" }; confirm the returned specSetHash equals \"d8d0de8331cd329204fcc90b244545fef16179ae30168e481a7987aa8d653a40\"; inspect ratings[\"item-contract-coverage\"]. All 8 plan item(s) are covered by active clauses or explicit exemptions."
      },
      "atomic-observable-behavior": {
        "rating": "pass",
        "evidence": "Source store: plans:get-specs { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\" }. Re-run exactly: plans:evaluate-spec-quality { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\", classRef:\"plan-class-migration\", expectedSpecSetHash:\"d8d0de8331cd329204fcc90b244545fef16179ae30168e481a7987aa8d653a40\" }; confirm the returned specSetHash equals \"d8d0de8331cd329204fcc90b244545fef16179ae30168e481a7987aa8d653a40\"; inspect ratings[\"atomic-observable-behavior\"]. 27 behavioral clause(s) are structurally atomic."
      },
      "falsifiability": {
        "rating": "pass",
        "evidence": "Source store: plans:get-specs { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\" }. Re-run exactly: plans:evaluate-spec-quality { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\", classRef:\"plan-class-migration\", expectedSpecSetHash:\"d8d0de8331cd329204fcc90b244545fef16179ae30168e481a7987aa8d653a40\" }; confirm the returned specSetHash equals \"d8d0de8331cd329204fcc90b244545fef16179ae30168e481a7987aa8d653a40\"; inspect ratings[\"falsifiability\"]. 27 behavioral clause(s) state falsifiable outcomes."
      },
      "implementation-independence": {
        "rating": "pass",
        "evidence": "Source store: plans:get-specs { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\" }. Re-run exactly: plans:evaluate-spec-quality { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\", classRef:\"plan-class-migration\", expectedSpecSetHash:\"d8d0de8331cd329204fcc90b244545fef16179ae30168e481a7987aa8d653a40\" }; confirm the returned specSetHash equals \"d8d0de8331cd329204fcc90b244545fef16179ae30168e481a7987aa8d653a40\"; inspect ratings[\"implementation-independence\"]. No active clause is coupled to an obvious implementation filename or construct."
      },
      "explicit-non-behavioral-exemptions": {
        "rating": "not-applicable",
        "evidence": "Source store: plans:get-specs { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\" }. Re-run exactly: plans:evaluate-spec-quality { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\", classRef:\"plan-class-migration\", expectedSpecSetHash:\"d8d0de8331cd329204fcc90b244545fef16179ae30168e481a7987aa8d653a40\" }; confirm the returned specSetHash equals \"d8d0de8331cd329204fcc90b244545fef16179ae30168e481a7987aa8d653a40\"; inspect ratings[\"explicit-non-behavioral-exemptions\"]. No clause claims a non-behavioral exemption."
      },
      "plan-class-specialization": {
        "rating": "pass",
        "evidence": "Source store: plans:get-specs { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\" }. Re-run exactly: plans:evaluate-spec-quality { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\", classRef:\"plan-class-migration\", expectedSpecSetHash:\"d8d0de8331cd329204fcc90b244545fef16179ae30168e481a7987aa8d653a40\" }; confirm the returned specSetHash equals \"d8d0de8331cd329204fcc90b244545fef16179ae30168e481a7987aa8d653a40\"; inspect ratings[\"plan-class-specialization\"]. Migration plan includes an active migration-data-integrity contract."
      },
      "spec-set-freshness": {
        "rating": "pass",
        "evidence": "Source store: plans:get-specs { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\" }. Re-run exactly: plans:evaluate-spec-quality { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\", classRef:\"plan-class-migration\", expectedSpecSetHash:\"d8d0de8331cd329204fcc90b244545fef16179ae30168e481a7987aa8d653a40\" }; confirm the returned specSetHash equals \"d8d0de8331cd329204fcc90b244545fef16179ae30168e481a7987aa8d653a40\"; inspect ratings[\"spec-set-freshness\"]. Verdict is pinned to exact current specSetHash d8d0de8331cd329204fcc90b244545fef16179ae30168e481a7987aa8d653a40 over 27 clause(s)."
      }
    },
    "terminal": true
  },
  "result": {
    "ok": true,
    "created": true,
    "issueId": "EI-28010179012065277",
    "evidenceFingerprint": "2513feceb6a63aed3027ecd826092474a95ff97436ff594170be711cf55f8258",
    "gradedGeneration": {
      "deployedSha": "d740fc3802",
      "hostStartedAt": "2026-11-05T21:43:16.000Z",
      "bootHeadSha": "2b7a8fc6ac027d941e3af3057074605a9c945324",
      "scoutCodeHash": null,
      "staleHost": true
    },
    "staleHost": true,
    "deployedSha": "d740fc3802",
    "gradingAuditPending": true,
    "gradingAuditNextStep": "The existing router automatically selects an independent auditor; declines and expiry advance its cascade, with a bounded fresh-judge fallback when no candidate is available. This card does not satisfy a gate until a NON-AUTHOR audits it. A DIFFERENT agent must emit { rubricRef:'grading-integrity', terminal:true, subject:{ kind:'scorecard', ref:'EI-28010179012065277' }, ratings:{...} }. Self-audits are refused, and re-emitting this card yourself files a duplicate pending card instead of settling this one.",
    "canonicalRatings": {
      "stable-revision-identity": {
        "rating": "pass",
        "evidence": "Source store: plans:get-specs { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\" }. Re-run exactly: plans:evaluate-spec-quality { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\", classRef:\"plan-class-migration\", expectedSpecSetHash:\"d8d0de8331cd329204fcc90b244545fef16179ae30168e481a7987aa8d653a40\" }; confirm the returned specSetHash equals \"d8d0de8331cd329204fcc90b244545fef16179ae30168e481a7987aa8d653a40\"; inspect ratings[\"stable-revision-identity\"]. 27 current clause(s) have unique identities, content hashes, and acceptance provenance."
      },
      "item-contract-coverage": {
        "rating": "pass",
        "evidence": "Source store: plans:get-specs { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\" }. Re-run exactly: plans:evaluate-spec-quality { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\", classRef:\"plan-class-migration\", expectedSpecSetHash:\"d8d0de8331cd329204fcc90b244545fef16179ae30168e481a7987aa8d653a40\" }; confirm the returned specSetHash equals \"d8d0de8331cd329204fcc90b244545fef16179ae30168e481a7987aa8d653a40\"; inspect ratings[\"item-contract-coverage\"]. All 8 plan item(s) are covered by active clauses or explicit exemptions."
      },
      "atomic-observable-behavior": {
        "rating": "pass",
        "evidence": "Source store: plans:get-specs { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\" }. Re-run exactly: plans:evaluate-spec-quality { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\", classRef:\"plan-class-migration\", expectedSpecSetHash:\"d8d0de8331cd329204fcc90b244545fef16179ae30168e481a7987aa8d653a40\" }; confirm the returned specSetHash equals \"d8d0de8331cd329204fcc90b244545fef16179ae30168e481a7987aa8d653a40\"; inspect ratings[\"atomic-observable-behavior\"]. 27 behavioral clause(s) are structurally atomic."
      },
      "falsifiability": {
        "rating": "pass",
        "evidence": "Source store: plans:get-specs { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\" }. Re-run exactly: plans:evaluate-spec-quality { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\", classRef:\"plan-class-migration\", expectedSpecSetHash:\"d8d0de8331cd329204fcc90b244545fef16179ae30168e481a7987aa8d653a40\" }; confirm the returned specSetHash equals \"d8d0de8331cd329204fcc90b244545fef16179ae30168e481a7987aa8d653a40\"; inspect ratings[\"falsifiability\"]. 27 behavioral clause(s) state falsifiable outcomes."
      },
      "implementation-independence": {
        "rating": "pass",
        "evidence": "Source store: plans:get-specs { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\" }. Re-run exactly: plans:evaluate-spec-quality { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\", classRef:\"plan-class-migration\", expectedSpecSetHash:\"d8d0de8331cd329204fcc90b244545fef16179ae30168e481a7987aa8d653a40\" }; confirm the returned specSetHash equals \"d8d0de8331cd329204fcc90b244545fef16179ae30168e481a7987aa8d653a40\"; inspect ratings[\"implementation-independence\"]. No active clause is coupled to an obvious implementation filename or construct."
      },
      "explicit-non-behavioral-exemptions": {
        "rating": "not-applicable",
        "evidence": "Source store: plans:get-specs { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\" }. Re-run exactly: plans:evaluate-spec-quality { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\", classRef:\"plan-class-migration\", expectedSpecSetHash:\"d8d0de8331cd329204fcc90b244545fef16179ae30168e481a7987aa8d653a40\" }; confirm the returned specSetHash equals \"d8d0de8331cd329204fcc90b244545fef16179ae30168e481a7987aa8d653a40\"; inspect ratings[\"explicit-non-behavioral-exemptions\"]. No clause claims a non-behavioral exemption."
      },
      "plan-class-specialization": {
        "rating": "pass",
        "evidence": "Source store: plans:get-specs { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\" }. Re-run exactly: plans:evaluate-spec-quality { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\", classRef:\"plan-class-migration\", expectedSpecSetHash:\"d8d0de8331cd329204fcc90b244545fef16179ae30168e481a7987aa8d653a40\" }; confirm the returned specSetHash equals \"d8d0de8331cd329204fcc90b244545fef16179ae30168e481a7987aa8d653a40\"; inspect ratings[\"plan-class-specialization\"]. Migration plan includes an active migration-data-integrity contract."
      },
      "spec-set-freshness": {
        "rating": "pass",
        "evidence": "Source store: plans:get-specs { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\" }. Re-run exactly: plans:evaluate-spec-quality { slug:\"node-to-bun-staged-migration-2026-10-22\", harness:\"papercusp\", classRef:\"plan-class-migration\", expectedSpecSetHash:\"d8d0de8331cd329204fcc90b244545fef16179ae30168e481a7987aa8d653a40\" }; confirm the returned specSetHash equals \"d8d0de8331cd329204fcc90b244545fef16179ae30168e481a7987aa8d653a40\"; inspect ratings[\"spec-set-freshness\"]. Verdict is pinned to exact current specSetHash d8d0de8331cd329204fcc90b244545fef16179ae30168e481a7987aa8d653a40 over 27 clause(s)."
      }
    },
    "completionReceipt": {
      "status": "recorded",
      "effectRef": "EI-28010179012065277"
    }
  }
}
