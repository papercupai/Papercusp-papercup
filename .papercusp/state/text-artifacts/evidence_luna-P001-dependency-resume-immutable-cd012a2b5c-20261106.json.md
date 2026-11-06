---
rel_path: "evidence/luna-P001-dependency-resume-immutable-cd012a2b5c-20261106.json"
updated_at: 1793937920804
_body: "content"
---

{
  "schemaVersion": "luna-dependency-resume-source-proof-v1",
  "workItemId": "WI-6554700010028547",
  "commit": "cd012a2b5ca2a7a9dc26887f1799b15947aa7726",
  "taskId": "0mw4g2jf31ajpyyg111",
  "testPath": "packages/operator-core/lib/source-preview-export.test.ts",
  "testNamePattern": "verifier dependency staging preparation boundary",
  "passed": 24,
  "failed": 0,
  "filtered": 458,
  "childSubstituted": 0,
  "scope": "Immutable source unit regression only; does not establish P001 native acceptance, BG activation or Luna shipment.",
  "command": "lint-as-committed.mjs test:file --any --ref=cd012a2b5ca2a7a9dc26887f1799b15947aa7726 -- packages/operator-core/lib/source-preview-export.test.ts -t 'verifier dependency staging preparation boundary'",
  "fingerprints": [
    {
      "path": "scripts/source-preview.mjs",
      "sha256": "5b7fb44010ac7cc0d4785f2237e4230126bda5a60d53465a4700cf933f34f5e1"
    },
    {
      "path": "packages/operator-core/lib/source-preview-export.test.ts",
      "sha256": "e74dd8dd1f8036debb999a02bdff16b04318f671d0f90bb397c1333e3dd364ae"
    }
  ],
  "summary": [
    "lint-as-committed: ref cd012a2b5ca2a7a9dc26887f1799b15947aa7726 = cd012a2b5c",
    "TEST_FILE_PROVENANCE head=cd012a2b5c testedPaths=1 uncommitted=0 unknown=0 phase=pre-run startedAt=2026-11-06T04:00:35.652Z",
    " Test Files  1 passed (1)",
    "      Tests  24 passed | 458 skipped (482)",
    "   Duration  8.68s (transform 3.49s, setup 579ms, import 4.88s, tests 2.10s, environment 0ms)",
    "TEST_FILE_PROVENANCE head=cd012a2b5c testedPaths=1 uncommitted=0 unknown=0 phase=post-run startedAt=2026-11-06T04:01:25.452Z",
    "TEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed head=cd012a2b5c uncommittedPaths=0/1 provenance=stamped startedAt=2026-11-06T04:00:35.652Z childSubstituted=0 childNoticeOffsetBytes=0 skippedTests=458",
    "[capability:bash] JOB END: status=completed exit=0 at 2026-11-06T04:02:01.876Z — this line was recorded by the transient-service runner; its file-backed sink survives loss of the operator host and is authoritative for durable output.",
    "[capability:bash] JOB END: status=completed exit=0 at 2026-11-06T04:02:01.990Z — this line marks the job reaching an OBSERVED terminal state; if it is ABSENT, no terminal marker has been durably recorded yet: the job may still be running, or it may have died before its close handler wrote JOB END. Check capability:bash_output/task ledger; recovery writes JOB DIED after a ledger-confirmed unobserved death."
  ],
  "logSha256": "87c210373d032543c6fef0caf71b932b4ccbcc9c684df299c80395406dacd2f0",
  "logPath": ".papercusp/scratch/bash-035d1fce-d22.log",
  "priorAdmissionOnlyFailure": {
    "taskId": "0mw4g00k5vmr17v1699",
    "exitCode": 2,
    "reason": "Missing required PAPERCUSP_TEST_RUNS_DB_URL; no tests executed."
  }
}
