---
rel_path: "evidence/identity-assume/recovery75/unit-mutation-manifest.json"
updated_at: 1792982381603
_body: "content"
---

[
  {
    "bar": "R-1",
    "original": "/tmp/assume75-r1-mutation.log",
    "artifact": "evidence/identity-assume/recovery75/r1-mutation.log.gz.b64",
    "bytes": 130428,
    "sha256": "ffe3ed1e1e2f2861c8fbec653fd639e84cbb6822d465a3c720b72166cdb7d4bd",
    "evidence": {
      "schemaVersion": 1,
      "runnerPath": "scripts/mutation-probe.sh",
      "result": {
        "baselineExit": 0,
        "target": "copy-out",
        "relocation": "overlay",
        "verdict": "caught",
        "guardExit": 1,
        "mutantParse": "ok",
        "copyBaselineLedger": "test_runs:22098175",
        "assertionEvidence": "test-file-assertion-failure",
        "baselineLedger": "test_runs:22098173",
        "mutantLedger": "test_runs:22098177",
        "expected": "caught"
      },
      "environment": {
        "PAPERCUSP_MUTATION_DESCRIPTOR_READER_REPO": "/tmp/pcv/papercusp-lint-as-committed-3334d25de1-WiHngT",
        "PAPERCUSP_TEST_RUN_HARNESS": "",
        "PAPERCUSP_MUTATION_DESCRIPTOR_READER_REQUIRED": 1,
        "PAPERCUSP_MUTATION_DESCRIPTOR_READER_HEALTH_URL": "http://127.0.0.1:9171/api/health",
        "PAPERCUSP_MUTATION_DESCRIPTOR_EXPORT": "auto"
      },
      "runnerSha256": "e621acee7ead3bfbc43f30d5a8e62f71506b80f5ef80660fe0092150af0aa403",
      "argv": [
        "--file",
        "packages/operator-core/lib/session-assume.ts",
        "--relocation",
        "overlay",
        "--mutate",
        "s/observation\\.hostId === caller\\.hostId/true/",
        "--test",
        "PROBE_SUBJECT={} node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/agent-tools/session/assume.test.ts --testNamePattern 'R-1 reject unrelated-window and env-only fake takeover'"
      ],
      "cwd": ".",
      "runnerCommit": "3334d25de11cb03a460abe2e6b6aa1b422db0095"
    }
  },
  {
    "bar": "R-2",
    "original": "/tmp/assume75-r2-mutation.log",
    "artifact": "evidence/identity-assume/recovery75/r2-mutation.log.gz.b64",
    "bytes": 130673,
    "sha256": "479ca0827504de3f64ba5bd113821800552a6f4c2f05c56c449c5ede6a1ce595",
    "evidence": {
      "environment": {
        "PAPERCUSP_MUTATION_DESCRIPTOR_READER_REQUIRED": 1,
        "PAPERCUSP_TEST_RUN_HARNESS": "",
        "PAPERCUSP_MUTATION_DESCRIPTOR_READER_HEALTH_URL": "http://127.0.0.1:9171/api/health",
        "PAPERCUSP_MUTATION_DESCRIPTOR_EXPORT": "auto",
        "PAPERCUSP_MUTATION_DESCRIPTOR_READER_REPO": "/tmp/pcv/papercusp-lint-as-committed-3334d25de1-WiHngT"
      },
      "runnerSha256": "e621acee7ead3bfbc43f30d5a8e62f71506b80f5ef80660fe0092150af0aa403",
      "result": {
        "baselineExit": 0,
        "assertionEvidence": "test-file-assertion-failure",
        "relocation": "overlay",
        "mutantParse": "ok",
        "target": "copy-out",
        "verdict": "caught",
        "baselineLedger": "test_runs:22098191",
        "mutantLedger": "test_runs:22098195",
        "guardExit": 1,
        "copyBaselineLedger": "test_runs:22098193",
        "expected": "caught"
      },
      "schemaVersion": 1,
      "cwd": ".",
      "argv": [
        "--file",
        "packages/operator-core/lib/session-assume.ts",
        "--relocation",
        "overlay",
        "--mutate",
        "s/observation\\.directedMessage\\.recipient === target\\.ownerId/true/",
        "--test",
        "PROBE_SUBJECT={} node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/agent-tools/session/assume.test.ts --testNamePattern 'R-2 target inbox and task routing spans before during and after cutover'"
      ],
      "runnerCommit": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
      "runnerPath": "scripts/mutation-probe.sh"
    }
  },
  {
    "bar": "R-3",
    "original": "/tmp/assume75-r3-mutation.log",
    "artifact": "evidence/identity-assume/recovery75/r3-mutation.log.gz.b64",
    "bytes": 133639,
    "sha256": "93fb2249286c99020f36805959d0707aaa7c46e5c935b1a0c93bea461e3a32b1",
    "evidence": {
      "schemaVersion": 1,
      "runnerPath": "scripts/mutation-probe.sh",
      "runnerCommit": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
      "argv": [
        "--file",
        "packages/operator-core/lib/session-assume.ts",
        "--relocation",
        "overlay",
        "--mutate",
        "s/    return refuse\\('context-unavailable'\\);/    return null;/",
        "--test",
        "PROBE_SUBJECT={} node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/agent-tools/session/assume.test.ts --testNamePattern 'R-3 unavailable corrupt stale and incompatible context refuses without fallback'"
      ],
      "cwd": ".",
      "environment": {
        "PAPERCUSP_MUTATION_DESCRIPTOR_READER_HEALTH_URL": "http://127.0.0.1:9171/api/health",
        "PAPERCUSP_MUTATION_DESCRIPTOR_EXPORT": "auto",
        "PAPERCUSP_TEST_RUN_HARNESS": "",
        "PAPERCUSP_MUTATION_DESCRIPTOR_READER_REQUIRED": 1,
        "PAPERCUSP_MUTATION_DESCRIPTOR_READER_REPO": "/tmp/pcv/papercusp-lint-as-committed-3334d25de1-WiHngT"
      },
      "result": {
        "copyBaselineLedger": "test_runs:22098247",
        "guardExit": 1,
        "baselineLedger": "test_runs:22098246",
        "baselineExit": 0,
        "assertionEvidence": "test-file-assertion-failure",
        "expected": "caught",
        "relocation": "overlay",
        "verdict": "caught",
        "mutantParse": "ok",
        "target": "copy-out",
        "mutantLedger": "test_runs:22098248"
      },
      "runnerSha256": "e621acee7ead3bfbc43f30d5a8e62f71506b80f5ef80660fe0092150af0aa403"
    }
  },
  {
    "bar": "R-4",
    "original": "/tmp/assume75-r4-mutation.log",
    "artifact": "evidence/identity-assume/recovery75/r4-mutation.log.gz.b64",
    "bytes": 131593,
    "sha256": "97a98f297512ba50d1081bc51b26fbe3042f29aaaf3da9ba4ea1cd8ede9903d0",
    "evidence": {
      "environment": {
        "PAPERCUSP_TEST_RUN_HARNESS": "",
        "PAPERCUSP_MUTATION_DESCRIPTOR_READER_REPO": "/tmp/pcv/papercusp-lint-as-committed-3334d25de1-WiHngT",
        "PAPERCUSP_MUTATION_DESCRIPTOR_READER_REQUIRED": 1,
        "PAPERCUSP_MUTATION_DESCRIPTOR_READER_HEALTH_URL": "http://127.0.0.1:9171/api/health",
        "PAPERCUSP_MUTATION_DESCRIPTOR_EXPORT": "auto"
      },
      "runnerSha256": "e621acee7ead3bfbc43f30d5a8e62f71506b80f5ef80660fe0092150af0aa403",
      "cwd": ".",
      "result": {
        "guardExit": 1,
        "mutantLedger": "test_runs:22098313",
        "expected": "caught",
        "verdict": "caught",
        "baselineExit": 0,
        "copyBaselineLedger": "test_runs:22098311",
        "mutantParse": "ok",
        "relocation": "overlay",
        "target": "copy-out",
        "baselineLedger": "test_runs:22098249",
        "assertionEvidence": "test-file-assertion-failure"
      },
      "runnerPath": "scripts/mutation-probe.sh",
      "argv": [
        "--file",
        "packages/operator-core/lib/session-assume.ts",
        "--relocation",
        "overlay",
        "--mutate",
        "s/if \\(!reservation\\.acquired\\)/if (false)/",
        "--test",
        "PROBE_SUBJECT={} node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/agent-tools/session/assume.test.ts --testNamePattern 'R-4 two callers race one target with one unchanged loser'"
      ],
      "schemaVersion": 1,
      "runnerCommit": "3334d25de11cb03a460abe2e6b6aa1b422db0095"
    }
  },
  {
    "bar": "R-5",
    "original": "/tmp/assume75-r5-mutation.log",
    "artifact": "evidence/identity-assume/recovery75/r5-mutation.log.gz.b64",
    "bytes": 133101,
    "sha256": "907a06ebaef43f59a221b5bdc7f3559a55224d3354d26232cc5fb45a84c804c3",
    "evidence": {
      "argv": [
        "--file",
        "packages/operator-core/lib/session-assume.ts",
        "--relocation",
        "overlay",
        "--mutate",
        "s/await record\\('caller-quiesced'\\);/receipt.disposition.releasedWorkClaims = []; await record('caller-quiesced');/",
        "--test",
        "PROBE_SUBJECT={} node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/agent-tools/session/assume.test.ts --testNamePattern 'R-5 nonempty caller work and return reference survive handoff failure'"
      ],
      "schemaVersion": 1,
      "runnerPath": "scripts/mutation-probe.sh",
      "runnerSha256": "e621acee7ead3bfbc43f30d5a8e62f71506b80f5ef80660fe0092150af0aa403",
      "runnerCommit": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
      "result": {
        "guardExit": 1,
        "baselineLedger": "test_runs:22098315",
        "expected": "caught",
        "target": "copy-out",
        "baselineExit": 0,
        "relocation": "overlay",
        "verdict": "caught",
        "copyBaselineLedger": "test_runs:22098317",
        "mutantParse": "ok",
        "assertionEvidence": "test-file-assertion-failure",
        "mutantLedger": "test_runs:22098319"
      },
      "cwd": ".",
      "environment": {
        "PAPERCUSP_MUTATION_DESCRIPTOR_READER_REPO": "/tmp/pcv/papercusp-lint-as-committed-3334d25de1-WiHngT",
        "PAPERCUSP_MUTATION_DESCRIPTOR_READER_REQUIRED": 1,
        "PAPERCUSP_TEST_RUN_HARNESS": "",
        "PAPERCUSP_MUTATION_DESCRIPTOR_READER_HEALTH_URL": "http://127.0.0.1:9171/api/health",
        "PAPERCUSP_MUTATION_DESCRIPTOR_EXPORT": "auto"
      }
    }
  },
  {
    "bar": "R-6",
    "original": "/tmp/assume75-r6-mutation.log",
    "artifact": "evidence/identity-assume/recovery75/r6-mutation.log.gz.b64",
    "bytes": 130011,
    "sha256": "367ea07fbdfbbba17b8fe77f84b67a6ea8ae10be43f3d4456bdcae6e65902c84",
    "evidence": {
      "runnerPath": "scripts/mutation-probe.sh",
      "result": {
        "baselineExit": 0,
        "verdict": "caught",
        "assertionEvidence": "test-file-assertion-failure",
        "mutantParse": "ok",
        "relocation": "overlay",
        "baselineLedger": "test_runs:22097645",
        "mutantLedger": "test_runs:22097651",
        "guardExit": 1,
        "copyBaselineLedger": "test_runs:22097649",
        "target": "copy-out",
        "expected": "caught"
      },
      "argv": [
        "--file",
        "packages/operator-core/lib/session-assume.ts",
        "--relocation",
        "overlay",
        "--mutate",
        "s/await record\\('handoff-accepted'\\);/await record('target-verified');/",
        "--test",
        "PROBE_SUBJECT={} node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/agent-tools/session/assume.test.ts --testNamePattern 'R-6 accepted requires later process and routed probe verification'"
      ],
      "environment": {
        "PAPERCUSP_MUTATION_DESCRIPTOR_READER_REPO": "/tmp/pcv/papercusp-lint-as-committed-3334d25de1-WiHngT",
        "PAPERCUSP_MUTATION_DESCRIPTOR_READER_HEALTH_URL": "http://127.0.0.1:9171/api/health",
        "PAPERCUSP_MUTATION_DESCRIPTOR_EXPORT": "auto",
        "PAPERCUSP_TEST_RUN_HARNESS": "",
        "PAPERCUSP_MUTATION_DESCRIPTOR_READER_REQUIRED": 1
      },
      "schemaVersion": 1,
      "cwd": ".",
      "runnerCommit": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
      "runnerSha256": "e621acee7ead3bfbc43f30d5a8e62f71506b80f5ef80660fe0092150af0aa403"
    }
  },
  {
    "bar": "R-8",
    "original": "/tmp/assume75-r8-mutation.log",
    "artifact": "evidence/identity-assume/recovery75/r8-mutation.log.gz.b64",
    "bytes": 131084,
    "sha256": "aed151d9f5038498fb5a2695614e52b0d97380fc4beec4f0aca82544dda50a9a",
    "evidence": {
      "cwd": ".",
      "runnerPath": "scripts/mutation-probe.sh",
      "schemaVersion": 1,
      "runnerSha256": "e621acee7ead3bfbc43f30d5a8e62f71506b80f5ef80660fe0092150af0aa403",
      "runnerCommit": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
      "environment": {
        "PAPERCUSP_MUTATION_DESCRIPTOR_READER_HEALTH_URL": "http://127.0.0.1:9171/api/health",
        "PAPERCUSP_MUTATION_DESCRIPTOR_EXPORT": "auto",
        "PAPERCUSP_MUTATION_DESCRIPTOR_READER_REPO": "/tmp/pcv/papercusp-lint-as-committed-3334d25de1-WiHngT",
        "PAPERCUSP_MUTATION_DESCRIPTOR_READER_REQUIRED": 1,
        "PAPERCUSP_TEST_RUN_HARNESS": ""
      },
      "result": {
        "guardExit": 1,
        "mutantLedger": "test_runs:22098327",
        "copyBaselineLedger": "test_runs:22098325",
        "mutantParse": "ok",
        "expected": "caught",
        "target": "copy-out",
        "baselineLedger": "test_runs:22098321",
        "baselineExit": 0,
        "verdict": "caught",
        "relocation": "overlay",
        "assertionEvidence": "test-file-assertion-failure"
      },
      "argv": [
        "--file",
        "packages/operator-core/lib/session-assume.ts",
        "--relocation",
        "overlay",
        "--mutate",
        "s/if \\(!cancelled\\) return receipt;/if (false) return receipt;/",
        "--test",
        "PROBE_SUBJECT={} node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/agent-tools/session/assume.test.ts --testNamePattern 'R-8 crash after target custody before exec or verification converges on retry'"
      ]
    }
  },
  {
    "bar": "R-9",
    "original": "/tmp/assume75-r9-mutation.log",
    "artifact": "evidence/identity-assume/recovery75/r9-mutation.log.gz.b64",
    "bytes": 131779,
    "sha256": "7310761f27c44f0438a95ce9dc8e6536f5b8b71d13cae0256eed1e89ea17e85f",
    "evidence": {
      "runnerCommit": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
      "runnerPath": "scripts/mutation-probe.sh",
      "result": {
        "baselineLedger": "test_runs:22098329",
        "verdict": "caught",
        "copyBaselineLedger": "test_runs:22098332",
        "baselineExit": 0,
        "guardExit": 1,
        "expected": "caught",
        "mutantParse": "ok",
        "assertionEvidence": "test-file-assertion-failure",
        "mutantLedger": "test_runs:22098334",
        "target": "copy-out",
        "relocation": "overlay"
      },
      "argv": [
        "--file",
        "packages/operator-core/lib/session-assume.ts",
        "--relocation",
        "overlay",
        "--mutate",
        "s/if \\(await deps\\.authorize\\(actor, plan\\.target\\.role\\) !== plan\\.authorizationRef\\)/if (false)/",
        "--test",
        "PROBE_SUBJECT={} node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/agent-tools/session/assume.test.ts --testNamePattern 'R-9 commit rechecks administrative authority and reviewer restrictions'"
      ],
      "schemaVersion": 1,
      "runnerSha256": "e621acee7ead3bfbc43f30d5a8e62f71506b80f5ef80660fe0092150af0aa403",
      "environment": {
        "PAPERCUSP_TEST_RUN_HARNESS": "",
        "PAPERCUSP_MUTATION_DESCRIPTOR_READER_REPO": "/tmp/pcv/papercusp-lint-as-committed-3334d25de1-WiHngT",
        "PAPERCUSP_MUTATION_DESCRIPTOR_READER_HEALTH_URL": "http://127.0.0.1:9171/api/health",
        "PAPERCUSP_MUTATION_DESCRIPTOR_EXPORT": "auto",
        "PAPERCUSP_MUTATION_DESCRIPTOR_READER_REQUIRED": 1
      },
      "cwd": "."
    }
  },
  {
    "bar": "R-10",
    "original": "/tmp/assume75-r10-mutation.log",
    "artifact": "evidence/identity-assume/recovery75/r10-mutation.log.gz.b64",
    "bytes": 131855,
    "sha256": "1a9603ca59ce7d553e0090f5d9c73f6890d354d76279d47cdc726e5a029f2767",
    "evidence": {
      "schemaVersion": 1,
      "runnerCommit": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
      "runnerSha256": "e621acee7ead3bfbc43f30d5a8e62f71506b80f5ef80660fe0092150af0aa403",
      "environment": {
        "PAPERCUSP_MUTATION_DESCRIPTOR_READER_REPO": "/tmp/pcv/papercusp-lint-as-committed-3334d25de1-WiHngT",
        "PAPERCUSP_MUTATION_DESCRIPTOR_READER_HEALTH_URL": "http://127.0.0.1:9171/api/health",
        "PAPERCUSP_MUTATION_DESCRIPTOR_READER_REQUIRED": 1,
        "PAPERCUSP_TEST_RUN_HARNESS": "",
        "PAPERCUSP_MUTATION_DESCRIPTOR_EXPORT": "auto"
      },
      "result": {
        "verdict": "caught",
        "assertionEvidence": "test-file-assertion-failure",
        "relocation": "overlay",
        "guardExit": 1,
        "target": "copy-out",
        "baselineLedger": "test_runs:22098337",
        "expected": "caught",
        "copyBaselineLedger": "test_runs:22098338",
        "mutantParse": "ok",
        "mutantLedger": "test_runs:22098840",
        "baselineExit": 0
      },
      "runnerPath": "scripts/mutation-probe.sh",
      "argv": [
        "--file",
        "packages/operator-core/lib/session-assume.ts",
        "--relocation",
        "overlay",
        "--mutate",
        "s/if \\(JSON\\.stringify\\(target\\.data\\) !== JSON\\.stringify\\(plan\\.target\\)\\)/if (false)/",
        "--test",
        "PROBE_SUBJECT={} node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/agent-tools/session/assume.test.ts --testNamePattern 'R-10 tampered mismatched or non-target checkpoint refuses before custody'"
      ],
      "cwd": "."
    }
  }
]
