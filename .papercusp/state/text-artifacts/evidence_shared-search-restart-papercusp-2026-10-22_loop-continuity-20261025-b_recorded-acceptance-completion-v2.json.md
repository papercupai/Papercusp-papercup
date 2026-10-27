---
rel_path: "evidence/shared-search-restart-papercusp-2026-10-22/loop-continuity-20261025-b/recorded-acceptance-completion-v2.json"
updated_at: 1792975472201
_body: "content"
---

{
  "summary": "Unify append-time compaction and directory GC on the existing bounded TTL-plus-24h-grace retention window. Live TTL remains unchanged; delayed native enrollment and expired hash-only authority regressions now pass. Genuine D-019 integration now exercises a verbatim recorded native wake plus enrollment, and the recorded instruction's exact visible text.",
  "testsRun": "testing:run {files:[\"packages/operator-core/lib/turn-provenance/turn-provenance-retention.test.ts\",\"packages/operator-core/lib/turn-provenance/turn-provenance-write-serialization.test.ts\"],harness:\"papercusp\",work_item_id:\"EI-26995183706038210\"}; build:typecheck project=packages/operator-core scopeToFiles=true files=the three changed TypeScript paths; git diff --check; NEW testing:run {files:[\"packages/operator-core/lib/turn-provenance/turn-provenance-recorded.integration.test.ts\"],harness:\"papercusp\",work_item_id:\"EI-26995183706038210\"}; scoped build:typecheck of new integration test; npm run lint:no-box-identity; npm run lint:no-identity-literals; exact JSON comparison ignoring only machine.sourceFile/machine.ledgerSource",
  "testResult": "8 passed, 0 failed, 0 skipped (ledger22078246/22078247; run81982fca-1993-4b1c-a0e6-2a39aecc5ad7). Scoped tsc-cli: requested-files-clean,0diagnostics in3requested files; scopedVerdictIncomplete=false. Transitive graph has27diagnostics outside requestedfiles; this is a scoped result. gitdiff--check passed. NEW integration: 2 passed,0 failed,0 skipped, test-run22084774/run5f3990bc-b844-43f3-bd59-af5c87521a78; scoped tsc-cli zero diagnostics, complete verdict. Original8 unit results retained, not repeated. Both maintained identity guards exit0 after replacing2absolute locator fields with environment-relative references; exact comparison confirms all other corpus fields unchanged, including recorded text/hash/enrollment/instruction. Current corpusSHA256bf673980d99e2ffe37197b42f0da59517802b605a7c589b598e07fc5f48d6cfa supersedes9ac620f5; no functional test rerun for metadata-only correction.",
  "verifiedHow": "integration",
  "filesChanged": [
    "packages/operator-core/lib/turn-provenance/turn-provenance.ts",
    "packages/operator-core/lib/turn-provenance/turn-provenance-retention.test.ts",
    "packages/operator-core/lib/turn-provenance/turn-provenance-write-serialization.test.ts",
    "packages/operator-core/lib/turn-provenance/turn-provenance-recorded.integration.test.ts",
    "packages/operator-core/lib/turn-provenance/fixtures/retention-recorded-turns.json"
  ],
  "kindEvidence": [
    {
      "kind": "logic",
      "testsRun": "testing:run {files:[\"packages/operator-core/lib/turn-provenance/turn-provenance-retention.test.ts\",\"packages/operator-core/lib/turn-provenance/turn-provenance-write-serialization.test.ts\"],harness:\"papercusp\",work_item_id:\"EI-26995183706038210\"}; build:typecheck project=packages/operator-core scopeToFiles=true files=the three changed TypeScript paths; git diff --check; NEW testing:run {files:[\"packages/operator-core/lib/turn-provenance/turn-provenance-recorded.integration.test.ts\"],harness:\"papercusp\",work_item_id:\"EI-26995183706038210\"}; scoped build:typecheck of new integration test; npm run lint:no-box-identity; npm run lint:no-identity-literals; exact JSON comparison ignoring only machine.sourceFile/machine.ledgerSource",
      "testResult": "8 passed, 0 failed, 0 skipped (ledger22078246/22078247; run81982fca-1993-4b1c-a0e6-2a39aecc5ad7). Scoped tsc-cli: requested-files-clean,0diagnostics in3requested files; scopedVerdictIncomplete=false. Transitive graph has27diagnostics outside requestedfiles; this is a scoped result. gitdiff--check passed. NEW integration: 2 passed,0 failed,0 skipped, test-run22084774/run5f3990bc-b844-43f3-bd59-af5c87521a78; scoped tsc-cli zero diagnostics, complete verdict. Original8 unit results retained, not repeated. Both maintained identity guards exit0 after replacing2absolute locator fields with environment-relative references; exact comparison confirms all other corpus fields unchanged, including recorded text/hash/enrollment/instruction. Current corpusSHA256bf673980d99e2ffe37197b42f0da59517802b605a7c589b598e07fc5f48d6cfa supersedes9ac620f5; no functional test rerun for metadata-only correction."
    }
  ],
  "rootCauseVerification": {
    "contractVersion": 2,
    "hypothesis": "Append-time compaction's TTL-only filter discards enrollment needed by delayed indexing and stale hash-only authority classification, although directory GC retains TTL+grace.",
    "alternativeHypothesis": "The native indexed validator inherently rejects post-TTL ingestion even with intact submission-valid enrollment history.",
    "distinguishingTest": "Place a typed loop enrollment valid at submission in a ledger over32KiB, append after its TTL but within24hgrace, then run the unchanged indexedLoopTurnStartRecord for the original submission time; compare the pre-fix and fixed compaction paths.",
    "testProcedure": "Maintained turn-provenance-retention.test.ts invokes appendLedgerRow at TTL+60s and production indexedLoopTurnStartRecord at submission+1s for claude/codex/omp; asserts current expired refusal. Additional cases check default/short/longTTL and exact grace+1ms reclamation plus hash-only classification. Run with original source, then with the shared retention helper, keeping the indexed validator unchanged.",
    "predictedObservations": {
      "hypothesis": "Original append deletes enrollment; shared TTL+grace restores indexed typed identity while live current-time classification remains expired.",
      "alternativeHypothesis": "Retaining the enrollment does not restore indexed typed identity; delayed-ingest cases still fail with the shared helper."
    },
    "actualObservation": "Original source failed7/7new regressions including absent enrollment and false owner-interactive on hash-only schedule. Shared helper passed7/7plus the revised serialization case. Delayed native identity restored and current expired classification refused. No attribution of the separate live-loop failure. New real-input integration22084774 retained the actual expired dd3f335d6db79de9 enrollment through >32KiB compaction, kept its real hash-only payload unverified, hid the recorded wake, and preserved exact indexed instruction text. The first new run22084772 exposed an incorrect author test expectation nonce vs observed nonce+hash; corrected only the new test. Corpus textSHA7e4ffb34f99ecf1721a973b71e4083876a07f746c215c6174972875eb76c06f0.",
    "testResult": "Distinguishing regression supports compaction-retention root cause for the demonstrated source defect, and falsifies inherent delayed-validator rejection in the bounded fixtures.",
    "evidenceRefs": [
      "test-run:22077266",
      "test-run:22078246",
      "test-run:22078247",
      "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-RXs1rc/manifest.json",
      "test-run:22084774",
      "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-iySe0y/manifest.json",
      "file:packages/operator-core/lib/turn-provenance/fixtures/retention-recorded-turns.json"
    ]
  },
  "verification": {
    "coverage": {
      "population": [
        "size-triggered historical retention",
        "delayed native typed ingestion",
        "current-time expired rejection",
        "default and per-row TTL grace boundaries",
        "past-grace reclamation",
        "expired hash-only authority preservation",
        "same-file write serialization",
        "real recorded-turn owner visibility and hash-only expiry"
      ],
      "checked": [
        "size-triggered historical retention",
        "delayed native typed ingestion",
        "current-time expired rejection",
        "default and per-row TTL grace boundaries",
        "past-grace reclamation",
        "expired hash-only authority preservation",
        "same-file write serialization",
        "real recorded-turn owner visibility and hash-only expiry"
      ],
      "notChecked": [],
      "notApplicable": [],
      "residue": []
    }
  }
}
