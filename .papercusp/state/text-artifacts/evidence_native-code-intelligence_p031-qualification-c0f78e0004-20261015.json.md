---
rel_path: "evidence/native-code-intelligence/p031-qualification-c0f78e0004-20261015.json"
updated_at: 1792029418993
_body: "content"
---

{
  "kind": "P-031 committed-source qualification",
  "plan": "native-code-intelligence-ecosystem-and-dream-2026-10-09",
  "taskId": "0mv8unw7g1vl961c1hc",
  "sourceCommit": "c0f78e00047fc5897938ab9f25171451a3502b1c",
  "verdict": "qualified",
  "taskExitCode": 0,
  "terminalEvidence": "capability:bash_output task_id + durable runner JOB END completed exit0 at2026-10-15T01:54:44.183Z",
  "source": {
    "schemaVersion": "verifier-source-v1",
    "receipt": "/tmp/p031-a92ec-immutable-20261015-0117.json",
    "sha256": "fd39fb06112b68f1a5e5ad2b79ee14c88224588d34e9b309e203247931960876",
    "fileCount": 40467,
    "testedInputs": [
      {
        "path": "docs/evidence/native-code-intelligence-p031-analyzer-admission-2026-10-14.json",
        "sha256": "8761f7e67a0ce13a5b2286d8ae8ac05cce3e637127b552363a55e5eac2f28a17"
      },
      {
        "path": "package.json",
        "sha256": "fa75a8809634233ceeba33bcff42b513ca3d23816209d7032e1057e5f2083823"
      },
      {
        "path": "packages/operator-core/lib/agent-tools/capability/git.test.ts",
        "sha256": "e5b1a7cbd273c47d6d9e69cbccb4542990afb06b63ad978c21bfa0d38fbf0c17"
      },
      {
        "path": "packages/operator-core/lib/agent-tools/lsp/astgrep.ts",
        "sha256": "02c764d407683fb59a9e9caf811fc90f4ec9b79cd180c0f42747ae5f84cd0bbe"
      },
      {
        "path": "packages/operator-core/lib/code-intelligence/ast-grep-facade.ts",
        "sha256": "02229b10b45e490db670b6447d01de8da36b0ddb1f6493b515d32d3b684ec7c1"
      },
      {
        "path": "packages/operator-core/lib/code-intelligence/lsp-adapter.ts",
        "sha256": "c59403ad480a25da521afa5359783ef6d59868a5f6c7f97ed7c7dcdce9d5b161"
      },
      {
        "path": "packages/operator-core/lib/code-intelligence/semgrep-runtime-manifest.json",
        "sha256": "2bdf58210b725c4b59b2754b8ecfdb9f1218c87092ee24fbc3ae1312e2a01ec2"
      },
      {
        "path": "packages/operator-core/lib/code-intelligence/semgrep-taint-facade.integration.test.ts",
        "sha256": "4f2b48062a7c91bf1a96cfaf34dc6f11b0a924cbbbf37d0c496a2e8c19ec9f39"
      },
      {
        "path": "packages/operator-core/lib/code-intelligence/semgrep-taint-facade.test.ts",
        "sha256": "9f216e476a5aa6a9193264903810117ca16a853316bd0dc7995cb7e02f134847"
      },
      {
        "path": "packages/operator-core/lib/code-intelligence/semgrep-taint-facade.ts",
        "sha256": "1d3517670d1c9cd123a89dd43dafeac13e3a4cde7fc5f559f73c10c1e7a4afe8"
      },
      {
        "path": "packages/operator-core/lib/scratch-git-clone.ts",
        "sha256": "c5ced978c1f4da28fe37cb21904c44d3f53a3cc26e5ad3632ceb2cc9b57e31f7"
      },
      {
        "path": "packages/operator-core/lib/source-preview-export.test.ts",
        "sha256": "a51c15b88a630cc76b05f587834dbd08f655fb8e5a5e93edd40767e13abf7356"
      },
      {
        "path": "packages/operator-core/lib/source-preview.fixture.ts",
        "sha256": "4a221e79999a4726dcdee01a0ebac73fd35ea73f0147580e3ca18e142a3209b2"
      },
      {
        "path": "packages/operator-core/lib/vitest-e2e-config-load.test.ts",
        "sha256": "84c652ae70ee61e9719fba37a58921fffeff76680faa6592a7b21b609df74687"
      },
      {
        "path": "packages/operator-core/vitest.config.ts",
        "sha256": "e4a79d32a604b4aa8605f80ec95b8aadc37a109452ecb8a685dd00d146fd0c49"
      },
      {
        "path": "packages/operator-core/vitest.e2e.config.ts",
        "sha256": "17cb695034b89513908b8b5cf433a623c5a00def672cf4c805994db3a490c217"
      },
      {
        "path": "packages/operator-core/vitest.integration.config.ts",
        "sha256": "a16e6b75ba81e4d8f9cb68e6fcad749e98629e9904077da8d07924956be45f14"
      },
      {
        "path": "scripts/lib/budgeted-task-scheduler.mjs",
        "sha256": "bc9fda2685fd00a02363145c1fbdbbc219ccf84bee8fd019d2f9c19ebe25e5c5"
      },
      {
        "path": "scripts/lib/committed-source-loader.mjs",
        "sha256": "2a23726d00da0f8ea46388be32aaa3e527d8b9c47265a0fa0ddb1af98038a61a"
      },
      {
        "path": "scripts/lib/executed-source-map.mjs",
        "sha256": "8905034052d5b812b9a6b8c95ab92a71de73cb59c51ed5cc54dcc1d5410a6a24"
      },
      {
        "path": "scripts/provision-lsp.ts",
        "sha256": "0616bf2173e8ad5e1e5ae9ae3b1274828099e0ae65b2a4f1926400ab0f3a211f"
      },
      {
        "path": "scripts/source-preview.d.mts",
        "sha256": "33fa0af4e82f9bbe8c57ca593ec375e79f95be898b03708463befe759f9c9732"
      },
      {
        "path": "scripts/source-preview.mjs",
        "sha256": "d30584fc42c858e112b6034e23ce3b4466aa99b63f8afbc1cbb04b68c18c7f0d"
      },
      {
        "path": "scripts/test-files.mjs",
        "sha256": "57c9c2c816ea9bec356c321c657df8d389a0a8aee84c7fe9235d5c61673ae97d"
      }
    ]
  },
  "dependencies": {
    "before": "/tmp/p031-a92ec-immutable-20261015-0117.json.dependencies.json",
    "after": "/tmp/p031-a92ec-immutable-20261015-0117.json.dependencies.after.json",
    "beforeSha256": "96fe224a18213da6322a3f6aaf492b8d0ef05afcd1f02bf4fe93717ccd2de5fd",
    "afterSha256": "96fe224a18213da6322a3f6aaf492b8d0ef05afcd1f02bf4fe93717ccd2de5fd",
    "fullEquality": true,
    "treesBefore": 98,
    "treesAfter": 98,
    "filesBefore": 325953,
    "filesAfter": 325953,
    "sourceReceiptMatches": true
  },
  "phases": [
    {
      "schemaVersion": "verifier-phase-v1",
      "sequence": 2,
      "taskId": "0mv8unw7g1vl961c1hc",
      "phase": "source.admission",
      "event": "completed",
      "elapsedMs": 2,
      "durationMs": 2
    },
    {
      "schemaVersion": "verifier-phase-v1",
      "sequence": 4,
      "taskId": "0mv8unw7g1vl961c1hc",
      "phase": "source.freeze",
      "event": "completed",
      "elapsedMs": 88910,
      "durationMs": 88908
    },
    {
      "schemaVersion": "verifier-phase-v1",
      "sequence": 6,
      "taskId": "0mv8unw7g1vl961c1hc",
      "phase": "receipt.write",
      "event": "completed",
      "elapsedMs": 89186,
      "durationMs": 276
    },
    {
      "schemaVersion": "verifier-phase-v1",
      "sequence": 8,
      "taskId": "0mv8unw7g1vl961c1hc",
      "phase": "deps.source.before",
      "event": "completed",
      "elapsedMs": 96201,
      "durationMs": 7014
    },
    {
      "schemaVersion": "verifier-phase-v1",
      "sequence": 10,
      "taskId": "0mv8unw7g1vl961c1hc",
      "phase": "deps.snapshot",
      "event": "completed",
      "elapsedMs": 471389,
      "durationMs": 375187
    },
    {
      "schemaVersion": "verifier-phase-v1",
      "sequence": 12,
      "taskId": "0mv8unw7g1vl961c1hc",
      "phase": "deps.source.after-snapshot",
      "event": "completed",
      "elapsedMs": 508429,
      "durationMs": 37038
    },
    {
      "schemaVersion": "verifier-phase-v1",
      "sequence": 14,
      "taskId": "0mv8unw7g1vl961c1hc",
      "phase": "deps.inputs",
      "event": "completed",
      "elapsedMs": 509118,
      "durationMs": 689
    },
    {
      "schemaVersion": "verifier-phase-v1",
      "sequence": 16,
      "taskId": "0mv8unw7g1vl961c1hc",
      "phase": "deps.measure",
      "event": "completed",
      "elapsedMs": 515214,
      "durationMs": 6095
    },
    {
      "schemaVersion": "verifier-phase-v1",
      "sequence": 18,
      "taskId": "0mv8unw7g1vl961c1hc",
      "phase": "deps.source.after-preflight",
      "event": "completed",
      "elapsedMs": 549000,
      "durationMs": 33786
    },
    {
      "schemaVersion": "verifier-phase-v1",
      "sequence": 20,
      "taskId": "0mv8unw7g1vl961c1hc",
      "phase": "deps.census",
      "event": "completed",
      "elapsedMs": 1058300,
      "durationMs": 509299
    },
    {
      "schemaVersion": "verifier-phase-v1",
      "sequence": 22,
      "taskId": "0mv8unw7g1vl961c1hc",
      "phase": "deps.receipt.write",
      "event": "completed",
      "elapsedMs": 1062751,
      "durationMs": 4448
    },
    {
      "schemaVersion": "verifier-phase-v1",
      "sequence": 24,
      "taskId": "0mv8unw7g1vl961c1hc",
      "phase": "child.admission",
      "event": "completed",
      "elapsedMs": 1062753,
      "durationMs": 1
    },
    {
      "schemaVersion": "verifier-phase-v1",
      "sequence": 26,
      "taskId": "0mv8unw7g1vl961c1hc",
      "phase": "child.preflight",
      "event": "completed",
      "elapsedMs": 1117768,
      "durationMs": 55014
    },
    {
      "schemaVersion": "verifier-phase-v1",
      "sequence": 28,
      "taskId": "0mv8unw7g1vl961c1hc",
      "phase": "child.run",
      "event": "completed",
      "elapsedMs": 1715174,
      "durationMs": 597403,
      "exitCode": 0
    },
    {
      "schemaVersion": "verifier-phase-v1",
      "sequence": 30,
      "taskId": "0mv8unw7g1vl961c1hc",
      "phase": "deps.postverify",
      "event": "completed",
      "elapsedMs": 2108842,
      "durationMs": 393656
    },
    {
      "schemaVersion": "verifier-phase-v1",
      "sequence": 32,
      "taskId": "0mv8unw7g1vl961c1hc",
      "phase": "source.postverify",
      "event": "completed",
      "elapsedMs": 2163186,
      "durationMs": 54343
    },
    {
      "schemaVersion": "verifier-phase-v1",
      "sequence": 34,
      "taskId": "0mv8unw7g1vl961c1hc",
      "phase": "cleanup",
      "event": "completed",
      "elapsedMs": 2187972,
      "durationMs": 24786
    }
  ],
  "phasesPath": "/tmp/p031-a92ec-immutable-20261015-0117.json.phases.jsonl",
  "phasesSha256": "f06cd47731b318466bb153127abfb8eefed292cf017405326e74ab5181ad8fc6",
  "gitTracePath": "/tmp/p031-a92ec-immutable-20261015-0117.git-trace.jsonl",
  "gitTraceSha256": "a9347385e2b68e9cf95a5eb580cea8cd24d89d9badae20def05f657ba5b6b440",
  "logPath": ".papercusp/scratch/bash-7a511491-356.log",
  "logSha256": "9bb9589f24381cc3f8ef2522b23e53237b40e810cdd9bc7879d67ad4fe7b5559",
  "removedRoot": "/home/marsh-office/papercupai-workspace/papercusp/.papercusp/scratch/verifier-command-FYfNzw/invoked-source",
  "rootAbsent": true,
  "ownedParentAbsent": true,
  "testLedgers": [
    {
      "id": 21249238,
      "file": "packages/operator-core/lib/vitest-e2e-config-load.test.ts",
      "passed": 8
    },
    {
      "id": 21249239,
      "file": "packages/operator-core/lib/code-intelligence/semgrep-taint-facade.test.ts",
      "passed": 9
    },
    {
      "id": 21249240,
      "file": "packages/operator-core/lib/agent-tools/capability/git.test.ts",
      "passed": 34
    },
    {
      "id": 21249241,
      "file": "packages/operator-core/lib/source-preview-export.test.ts",
      "passed": 131
    },
    {
      "id": 21249254,
      "file": "packages/operator-core/lib/code-intelligence/semgrep-taint-facade.integration.test.ts",
      "passed": 9
    }
  ],
  "ledgerQualification": {
    "failed": 0,
    "skipped": 0,
    "collectionFailed": false,
    "worktreeDirty": false,
    "isScratchConfig": false,
    "sourceCommit": "c0f78e00047fc5897938ab9f25171451a3502b1c",
    "root": "/home/marsh-office/papercupai-workspace/papercusp/.papercusp/scratch/verifier-command-FYfNzw/invoked-source",
    "readEvidence": "scoped dev:pg_query over exact five test_runs IDs; execution_details object root and counts verified"
  },
  "limits": "Preparatory P031 qualified source only; not final P031/whole-plan acceptance, P026 foundation, deployment, native-adoption good use, or D011 equal72h proof."
}
