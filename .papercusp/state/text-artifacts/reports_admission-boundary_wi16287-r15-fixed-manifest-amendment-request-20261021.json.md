---
rel_path: "reports/admission-boundary/wi16287-r15-fixed-manifest-amendment-request-20261021.json"
updated_at: 1792588113360
_body: "content"
---

{
  "schemaVersion": 2,
  "args": {
    "rubricRef": "acceptance-work-queue-exclusion-alarm-duplicates-2026-10-16",
    "requirement": {
      "key": "r-15",
      "intent": {
        "request": "The registration-only extension fixed nine-path source set in the SHA256-pinned manifest matches both its committed candidate and its independently identified named shipped artifact."
      },
      "acceptance": {
        "condition": "The registration-only extension fixed nine-path source set in the SHA256-pinned manifest matches both its committed candidate and its independently identified named shipped artifact."
      },
      "verification": {
        "method": "Load and re-resolve the separate extension manifest reports/admission-boundary/wi-16287-passive-registration-extension-20261021.json from slug papercusp. Compare every extension path SHA256 at both the git-sync committed candidate and the exact named shipped artifact. The artifact identity must be measured and qualified by the independent final shipment reviewer. Missing paths, mismatches, unknown artifact identity or incomplete coverage forbid P-005/ship. Keep R-7's exactly FOUR original admission paths, incumbent proof custody, read-only mirror and P-037 no-replay requirement unchanged. D-008 and SC-004 supply the derived extension-shipment promise; this BAR supplies its previously missing gradeable outcome. No local test or staging operator result qualifies final-release evidence.\n\nManifest pin: the exact UTF-8 content of papercusp:reports/admission-boundary/wi-16287-passive-registration-extension-20261021.json must SHA256 to 042b87589a49243c8a88470e52cb683901cd1e6be95f1bbd7e35788d2a90af39. Its fixed files population is exactly these nine repository-relative paths: packages/operator-core/lib/agent-tools/harness/create.ts; packages/operator-core/lib/harness-registry.ts; packages/operator-core/lib/harness/git-sync/git-sync-eligibility.ts; packages/operator-core/lib/harness/git-sync/git-sync-eligibility.test.ts; packages/operator-core/lib/harness/git-sync/git-sync-reconcile.test.ts; packages/operator-core/lib/agent-tools/harness/__tests__/create-registration-only.integration.test.ts; packages/operator-core/lib/sync/hyperbee/boot-all.ts; packages/operator-core/lib/sync/hyperbee/__tests__/boot-all.test.ts; packages/operator-core/lib/release/git-sync-stall-watchdog.ts. Compare each fixed path against its top-level files[].sha256 at the committed candidate ca13500624b050ffe2cef164a2b9673defe67795 and at the independently identified shipped artifact. The previousCapture field is historical and supplies no current expected hashes. Reject a changed manifest hash, path additions, omissions, duplicates, source mismatch or unknown artifact identity. Retain the original four-path manifest and all incumbent custody, mirror, P-037 no-replay and R-7/P-005 boundaries."
      }
    },
    "expectedRubricRevision": 9,
    "expectedSubjectPlanRevision": 38,
    "idempotencyKey": "wi16287-r15-fixed-manifest-contract-20261021",
    "reason": "Address independent reviewer1192999 final-manifest follow-up only: pin immutable manifest content and enumerate its exact nine-path extension population before final grading. Preserve all existing acceptance methods, artifact runtime, original four-path manifest and proof/shipment fences."
  },
  "manifestSha256": "042b87589a49243c8a88470e52cb683901cd1e6be95f1bbd7e35788d2a90af39",
  "manifestChars": 7324,
  "supersededMethodOnlyPreview": "review-cd2062003b320b9430f71b99da77a78671520efad1e8928cd0bdbf329f7b14aa",
  "instruction": "HISTORICAL APPLIED — do not replay this CAS38 request or prior CAS35. Canonical rubric10/D012 applied with approval1193007 for preview1193004. Source40 exact R15 parity is re-audited11. Next: final revision10 meta critique/attestation and audited spec-quality, qualify extension evidence; retain all original fences.",
  "applied": {
    "rubricRevision": 10,
    "criteriaHash": "8f39bfb045c9dd868be75146aa22c21b1e9b9caecc0c331f1a0b0467874003d5",
    "barSetHash": "310795fdfb51094a8674a341fa86980f55bf87eba26e3ff9dc2fe6db9f405ab2",
    "approvalRef": "thread-post:1193007",
    "sourceRevision": 40,
    "sourceContentHash": "dd9c292c0def42c7f7e19236112d36ddf7c7aabff7c274fd1d25f0688dc4a87e",
    "auditSeq": 11
  }
}
