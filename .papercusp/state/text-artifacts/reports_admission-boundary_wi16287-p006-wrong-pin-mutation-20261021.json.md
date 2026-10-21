---
rel_path: "reports/admission-boundary/wi16287-p006-wrong-pin-mutation-20261021.json"
updated_at: 1792598047532
_body: "content"
---

{
  "schemaVersion": 1,
  "workItem": "WI-6554700010019137",
  "plan": "work-queue-exclusion-alarm-duplicates-2026-10-16",
  "behavior": "wrong-pin rejection before registration mutation",
  "probe": {
    "argv": [
      "--file",
      "packages/operator-core/lib/agent-tools/harness/create.ts",
      "--mutate",
      "s/if \\(commitSha !== args.expectedCommit\\)/if (false)/",
      "--relocation",
      "overlay",
      "--test",
      "test -f {} && npm run test:file -- packages/operator-core/lib/agent-tools/harness/__tests__/create-registration-only.integration.test.ts -- --testNamePattern=\"R12 rejects wrong-pin before registry mutation\""
    ],
    "environment": {
      "PAPERCUSP_MUTATION_DESCRIPTOR_READER_HEALTH_URL": "http://127.0.0.1:3170/api/health",
      "PAPERCUSP_MUTATION_DESCRIPTOR_READER_REPO": "/home/marsh-office/papercupai-workspace/papercusp",
      "PAPERCUSP_MUTATION_DESCRIPTOR_EXPORT": "auto",
      "PAPERCUSP_TEST_RUN_HARNESS": "papercusp"
    },
    "result": {
      "target": "copy-out",
      "baselineExit": 0,
      "relocation": "overlay",
      "mutantLedger": "test_runs:21597383",
      "copyBaselineLedger": "test_runs:21597131",
      "expected": "caught",
      "verdict": "caught",
      "mutantParse": "ok",
      "guardExit": 1,
      "assertionEvidence": "test-file-assertion-failure",
      "baselineLedger": "test_runs:21597119"
    },
    "runnerSha256": "ffb64b6dad3f3481546b77179b1c05ddc08e44726a69e5d4e45ddb60016f3e1e",
    "runnerCommit": "ca13500624b050ffe2cef164a2b9673defe67795",
    "cwd": ".",
    "schemaVersion": 1,
    "runnerPath": "scripts/mutation-probe.sh"
  },
  "log": "/tmp/su6c30-p006-mutation-pin-1530.log",
  "logSha256": "7d0fccbaa40202128ecc6a6b2f66204bbf7af0f467474b049bee75127b8f75d4",
  "subjectSha256": "4690e593ae46f185e9f424f0f75141f0c5f4b7d445afe824a2d66c494f4984f0",
  "treeIntegrityVerified": true,
  "bindings": {
    "ADM-P006-INVALID-IDENTITY@1": {
      "test": 63203,
      "mutation": 63239
    },
    "AUTO-BAR-R-12-P-006@3": {
      "test": 63197,
      "mutation": 63240
    }
  },
  "scopeLimitations": [
    "Targeted wrong-pin case only; other R12 invalid-identity scenarios are not mutation-proven by this probe.",
    "Missing unit controls remain open.",
    "No qualification of config/main/external/child runtime, original proof custody, final acceptance or shipment."
  ],
  "originalFourPathManifest": "unchanged/separate",
  "R15FixedNinePathManifest": "unchanged",
  "bindingNote": "Live full named-case baseline bindings retained; targeted test bindings 63237/63238 withdrawn. Canonical mutation descriptor still links the targeted baseline/copy-baseline ledger runs."
}

