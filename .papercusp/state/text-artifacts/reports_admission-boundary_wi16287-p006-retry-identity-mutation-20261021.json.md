---
rel_path: "reports/admission-boundary/wi16287-p006-retry-identity-mutation-20261021.json"
updated_at: 1792597736645
_body: "content"
---

{
  "schemaVersion": 1,
  "workItem": "WI-6554700010019137",
  "plan": "work-queue-exclusion-alarm-duplicates-2026-10-16",
  "behavior": "concurrent identical retry identity preservation",
  "probe": {
    "runnerPath": "scripts/mutation-probe.sh",
    "environment": {
      "PAPERCUSP_MUTATION_DESCRIPTOR_READER_HEALTH_URL": "http://127.0.0.1:3170/api/health",
      "PAPERCUSP_MUTATION_DESCRIPTOR_READER_REPO": "/home/marsh-office/papercupai-workspace/papercusp",
      "PAPERCUSP_MUTATION_DESCRIPTOR_EXPORT": "auto",
      "PAPERCUSP_TEST_RUN_HARNESS": "papercusp"
    },
    "runnerCommit": "ca13500624b050ffe2cef164a2b9673defe67795",
    "result": {
      "target": "copy-out",
      "mutantLedger": "test_runs:21597513",
      "baselineExit": 0,
      "copyBaselineLedger": "test_runs:21597508",
      "verdict": "caught",
      "expected": "caught",
      "guardExit": 1,
      "baselineLedger": "test_runs:21597505",
      "relocation": "overlay",
      "mutantParse": "ok",
      "assertionEvidence": "test-file-assertion-failure"
    },
    "argv": [
      "--file",
      "packages/operator-core/lib/agent-tools/harness/create.ts",
      "--mutate",
      "s/return cur;/return { ...cur, projects: [...cur.projects, collision] };/",
      "--relocation",
      "overlay",
      "--test",
      "test -f {} && npm run test:file -- packages/operator-core/lib/agent-tools/harness/__tests__/create-registration-only.integration.test.ts -- --testNamePattern=\"R13 concurrent identical retries keep one registration identity\""
    ],
    "schemaVersion": 1,
    "cwd": ".",
    "runnerSha256": "ffb64b6dad3f3481546b77179b1c05ddc08e44726a69e5d4e45ddb60016f3e1e"
  },
  "log": "/tmp/su6c30-p006-mutation-retry-1537.log",
  "logSha256": "6532486ed3688a74157abf7395472c936e4447ef1c4289870da970e0cadf67c6",
  "bindings": {
    "ADM-P006-IDEMPOTENT-RETRY@1": {
      "mutation": 21597513,
      "baseline": 21597505,
      "copyBaseline": 21597508,
      "binding": 63241
    },
    "AUTO-BAR-R-13-P-006@3": {
      "mutation": 21597513,
      "baseline": 21597505,
      "copyBaseline": 21597508,
      "binding": 63242
    }
  },
  "treeIntegrityVerified": true,
  "scopeLimitations": [
    "Targeted concurrent identical retry case only; unit controls and other source/runtime planes remain open.",
    "No final acceptance or shipment qualification."
  ]
}

