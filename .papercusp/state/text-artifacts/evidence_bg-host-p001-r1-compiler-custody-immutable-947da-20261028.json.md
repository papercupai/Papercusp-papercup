---
rel_path: "evidence/bg-host-p001-r1-compiler-custody-immutable-947da-20261028.json"
updated_at: 1793226277014
_body: "content"
---

{
  "scope": "P001 R1 three exact compiler selectors; source proof only. P001/runtime/Luna shipment incomplete.",
  "commit": "947da51fa40e2dbde19d1dab8ef98f6f8d3f704e",
  "root": "/tmp/pcv/papercusp-lint-as-committed-947da51fa4-joRoaA",
  "canonicalLedger": {
    "advisory": "\u26a0 harness_shared.test_runs: workspace_id/harness_slug are NULL-by-design for CI/dogfood-reporter rows (env-derived \u2014 libs/test-config/src/admin-test-runs-reporter.ts \u2014 and stamped ONLY by the per-hive Tests-tab ingestion route, migration 413). A workspace_id/harness_slug predicate therefore silently EXCLUDES every CI/gate row and reads as a clean 'no failures' \u2014 for CI/gate triage scope by source/commit_sha instead. Also: status values are 'pass'/'fail'/'skip', NOT 'passed'/'failed' \u2014 status <> 'passed' matches every row (EI-19324633485547042).",
    "mode": "query",
    "rowCount": 15,
    "truncated": false,
    "fields": [
      "id",
      "file_path",
      "file_status",
      "commit_sha",
      "source",
      "worktree_dirty",
      "case_key",
      "case_index",
      "status",
      "duration_ms",
      "error_tail"
    ],
    "elapsedMs": 520,
    "rows": [
      {
        "id": "22576303",
        "file_path": "packages/operator-core/lib/release/operator-artifact.test.ts",
        "file_status": "pass",
        "commit_sha": "947da51fa40e2dbde19d1dab8ef98f6f8d3f704e",
        "source": "local",
        "worktree_dirty": false,
        "case_key": "BG compiler input custody > bg-r1-compiler-source-transient-substitution-restored rejects selected source changed during real compiler consumption then restored before final fence",
        "case_index": 13,
        "status": "pass",
        "duration_ms": 2622,
        "error_tail": null
      },
      {
        "id": "22576303",
        "file_path": "packages/operator-core/lib/release/operator-artifact.test.ts",
        "file_status": "pass",
        "commit_sha": "947da51fa40e2dbde19d1dab8ef98f6f8d3f704e",
        "source": "local",
        "worktree_dirty": false,
        "case_key": "BG compiler input custody > bg-r1-compiler-dependency-transient-substitution-restored rejects selected dependency changed during real compiler consumption then restored before final fence",
        "case_index": 14,
        "status": "pass",
        "duration_ms": 1947,
        "error_tail": null
      },
      {
        "id": "22576303",
        "file_path": "packages/operator-core/lib/release/operator-artifact.test.ts",
        "file_status": "pass",
        "commit_sha": "947da51fa40e2dbde19d1dab8ef98f6f8d3f704e",
        "source": "local",
        "worktree_dirty": false,
        "case_key": "BG compiler input custody > bg-r1-compiler-immutable-input-positive-control qualifies ordinary real compilation from the frozen accepted source and dependency bytes",
        "case_index": 15,
        "status": "pass",
        "duration_ms": 2013,
        "error_tail": null
      },
      {
        "id": "22576364",
        "file_path": "packages/operator-core/lib/release/operator-artifact.test.ts",
        "file_status": "pass",
        "commit_sha": "947da51fa40e2dbde19d1dab8ef98f6f8d3f704e",
        "source": "mutation-probe",
        "worktree_dirty": false,
        "case_key": "BG compiler input custody > bg-r1-compiler-source-transient-substitution-restored rejects selected source changed during real compiler consumption then restored before final fence",
        "case_index": 13,
        "status": "pass",
        "duration_ms": 3144,
        "error_tail": null
      },
      {
        "id": "22576364",
        "file_path": "packages/operator-core/lib/release/operator-artifact.test.ts",
        "file_status": "pass",
        "commit_sha": "947da51fa40e2dbde19d1dab8ef98f6f8d3f704e",
        "source": "mutation-probe",
        "worktree_dirty": false,
        "case_key": "BG compiler input custody > bg-r1-compiler-immutable-input-positive-control qualifies ordinary real compilation from the frozen accepted source and dependency bytes",
        "case_index": 15,
        "status": "pass",
        "duration_ms": 3564,
        "error_tail": null
      },
      {
        "id": "22576372",
        "file_path": "packages/operator-core/lib/release/operator-artifact.test.ts",
        "file_status": "pass",
        "commit_sha": "947da51fa40e2dbde19d1dab8ef98f6f8d3f704e",
        "source": "mutation-probe",
        "worktree_dirty": false,
        "case_key": "BG compiler input custody > bg-r1-compiler-source-transient-substitution-restored rejects selected source changed during real compiler consumption then restored before final fence",
        "case_index": 13,
        "status": "pass",
        "duration_ms": 3361,
        "error_tail": null
      },
      {
        "id": "22576372",
        "file_path": "packages/operator-core/lib/release/operator-artifact.test.ts",
        "file_status": "pass",
        "commit_sha": "947da51fa40e2dbde19d1dab8ef98f6f8d3f704e",
        "source": "mutation-probe",
        "worktree_dirty": false,
        "case_key": "BG compiler input custody > bg-r1-compiler-immutable-input-positive-control qualifies ordinary real compilation from the frozen accepted source and dependency bytes",
        "case_index": 15,
        "status": "pass",
        "duration_ms": 3367,
        "error_tail": null
      },
      {
        "id": "22576405",
        "file_path": "packages/operator-core/lib/release/operator-artifact.test.ts",
        "file_status": "fail",
        "commit_sha": "947da51fa40e2dbde19d1dab8ef98f6f8d3f704e",
        "source": "mutation-probe",
        "worktree_dirty": false,
        "case_key": "BG compiler input custody > bg-r1-compiler-source-transient-substitution-restored rejects selected source changed during real compiler consumption then restored before final fence",
        "case_index": 13,
        "status": "fail",
        "duration_ms": 3175,
        "error_tail": "expected { status: 'compiled', \u2026(1) } to deeply equal { status: 'rejected', \u2026(1) }\nactual: {\n  \"emitted\": {\n    \"dep\": 41,\n    \"y\": 9,\n  },\n  \"status\": \"compiled\",\n}\nexpected: {\n  \"error\": StringContaining \"BG compiler consumed bytes mismatch: packages/core/index.ts\",\n  \"status\": \"rejected\",\n}"
      },
      {
        "id": "22576405",
        "file_path": "packages/operator-core/lib/release/operator-artifact.test.ts",
        "file_status": "fail",
        "commit_sha": "947da51fa40e2dbde19d1dab8ef98f6f8d3f704e",
        "source": "mutation-probe",
        "worktree_dirty": false,
        "case_key": "BG compiler input custody > bg-r1-compiler-immutable-input-positive-control qualifies ordinary real compilation from the frozen accepted source and dependency bytes",
        "case_index": 15,
        "status": "pass",
        "duration_ms": 2878,
        "error_tail": null
      },
      {
        "id": "22576420",
        "file_path": "packages/operator-core/lib/release/operator-artifact.test.ts",
        "file_status": "pass",
        "commit_sha": "947da51fa40e2dbde19d1dab8ef98f6f8d3f704e",
        "source": "mutation-probe",
        "worktree_dirty": false,
        "case_key": "BG compiler input custody > bg-r1-compiler-dependency-transient-substitution-restored rejects selected dependency changed during real compiler consumption then restored before final fence",
        "case_index": 14,
        "status": "pass",
        "duration_ms": 3485,
        "error_tail": null
      },
      {
        "id": "22576420",
        "file_path": "packages/operator-core/lib/release/operator-artifact.test.ts",
        "file_status": "pass",
        "commit_sha": "947da51fa40e2dbde19d1dab8ef98f6f8d3f704e",
        "source": "mutation-probe",
        "worktree_dirty": false,
        "case_key": "BG compiler input custody > bg-r1-compiler-immutable-input-positive-control qualifies ordinary real compilation from the frozen accepted source and dependency bytes",
        "case_index": 15,
        "status": "pass",
        "duration_ms": 2968,
        "error_tail": null
      },
      {
        "id": "22576424",
        "file_path": "packages/operator-core/lib/release/operator-artifact.test.ts",
        "file_status": "pass",
        "commit_sha": "947da51fa40e2dbde19d1dab8ef98f6f8d3f704e",
        "source": "mutation-probe",
        "worktree_dirty": false,
        "case_key": "BG compiler input custody > bg-r1-compiler-dependency-transient-substitution-restored rejects selected dependency changed during real compiler consumption then restored before final fence",
        "case_index": 14,
        "status": "pass",
        "duration_ms": 2734,
        "error_tail": null
      },
      {
        "id": "22576424",
        "file_path": "packages/operator-core/lib/release/operator-artifact.test.ts",
        "file_status": "pass",
        "commit_sha": "947da51fa40e2dbde19d1dab8ef98f6f8d3f704e",
        "source": "mutation-probe",
        "worktree_dirty": false,
        "case_key": "BG compiler input custody > bg-r1-compiler-immutable-input-positive-control qualifies ordinary real compilation from the frozen accepted source and dependency bytes",
        "case_index": 15,
        "status": "pass",
        "duration_ms": 3624,
        "error_tail": null
      },
      {
        "id": "22576428",
        "file_path": "packages/operator-core/lib/release/operator-artifact.test.ts",
        "file_status": "fail",
        "commit_sha": "947da51fa40e2dbde19d1dab8ef98f6f8d3f704e",
        "source": "mutation-probe",
        "worktree_dirty": false,
        "case_key": "BG compiler input custody > bg-r1-compiler-dependency-transient-substitution-restored rejects selected dependency changed during real compiler consumption then restored before final fence",
        "case_index": 14,
        "status": "fail",
        "duration_ms": 4064,
        "error_tail": "expected { status: 'compiled', \u2026(1) } to deeply equal { status: 'rejected', \u2026(1) }\nactual: {\n  \"emitted\": {\n    \"dep\": 99,\n    \"y\": 2,\n  },\n  \"status\": \"compiled\",\n}\nexpected: {\n  \"error\": StringContaining \"BG compiler consumed bytes mismatch: node_modules/fixture-dependency/index.js\",\n  \"status\": \"rejected\",\n}"
      },
      {
        "id": "22576428",
        "file_path": "packages/operator-core/lib/release/operator-artifact.test.ts",
        "file_status": "fail",
        "commit_sha": "947da51fa40e2dbde19d1dab8ef98f6f8d3f704e",
        "source": "mutation-probe",
        "worktree_dirty": false,
        "case_key": "BG compiler input custody > bg-r1-compiler-immutable-input-positive-control qualifies ordinary real compilation from the frozen accepted source and dependency bytes",
        "case_index": 15,
        "status": "pass",
        "duration_ms": 5771,
        "error_tail": null
      }
    ]
  },
  "fingerprints": {
    "scripts/source-preview.mjs": "2d01a14375061fb49752d0d03554a79d6f19733ed85de9314a31f295c68c456e",
    "packages/operator-core/lib/source-preview.fixture.ts": "0e40c96262275cc39f545dd1740173fb4e7a3eb3178f4872a84de8d73e4f540b",
    "packages/operator-core/lib/release/operator-artifact.test.ts": "ba2adf7b69f0fafba00921c13c32254960e0c00d31fb7047716144289648287b"
  },
  "probes": {
    "source": {
      "cwd": ".",
      "runnerCommit": "947da51fa40e2dbde19d1dab8ef98f6f8d3f704e",
      "schemaVersion": 1,
      "result": {
        "relocation": "overlay",
        "baselineExit": 0,
        "verdict": "caught",
        "baselineLedger": "test_runs:22576364",
        "mutantLedger": "test_runs:22576405",
        "guardExit": 1,
        "mutantParse": "ok",
        "expected": "caught",
        "assertionEvidence": "test-file-assertion-failure",
        "target": "copy-out",
        "copyBaselineLedger": "test_runs:22576372"
      },
      "runnerPath": "scripts/mutation-probe.sh",
      "runnerSha256": "2628b33b9f35ba8f4807168a398d011537dd771e891e1174d22a22e4898a9549",
      "environment": {
        "PAPERCUSP_MUTATION_DESCRIPTOR_EXPORT": "auto",
        "PAPERCUSP_TEST_RUN_HARNESS": "papercusp",
        "PAPERCUSP_MUTATION_DESCRIPTOR_READER_HEALTH_URL": "http://127.0.0.1:3170/api/health",
        "PAPERCUSP_MUTATION_DESCRIPTOR_READER_REPO": "/tmp/pcv/papercusp-lint-as-committed-947da51fa4-joRoaA",
        "PAPERCUSP_MUTATION_DESCRIPTOR_READER_REQUIRED": 1
      },
      "argv": [
        "--file",
        "scripts/source-preview.mjs",
        "--relocation",
        "overlay",
        "--fake-destructive",
        "--mutate",
        "s/assert\\.equal\\(sha256, expected\\.sha256,/assert.equal(expected.sha256, expected.sha256,/",
        "--test",
        "PROBE_SUBJECT={} PAPERCUSP_TEST_RUN_HARNESS=papercusp PAPERCUSP_WORKSPACE_ID=papercusp-workspace npm run test:file -- packages/operator-core/lib/release/operator-artifact.test.ts --testNamePattern=\"bg-r1-compiler-(source|immutable)\"",
        "--expect",
        "caught"
      ]
    },
    "dependency": {
      "runnerCommit": "947da51fa40e2dbde19d1dab8ef98f6f8d3f704e",
      "environment": {
        "PAPERCUSP_TEST_RUN_HARNESS": "papercusp",
        "PAPERCUSP_MUTATION_DESCRIPTOR_READER_REPO": "/tmp/pcv/papercusp-lint-as-committed-947da51fa4-joRoaA",
        "PAPERCUSP_MUTATION_DESCRIPTOR_EXPORT": "auto",
        "PAPERCUSP_MUTATION_DESCRIPTOR_READER_HEALTH_URL": "http://127.0.0.1:3170/api/health",
        "PAPERCUSP_MUTATION_DESCRIPTOR_READER_REQUIRED": 1
      },
      "runnerSha256": "2628b33b9f35ba8f4807168a398d011537dd771e891e1174d22a22e4898a9549",
      "argv": [
        "--file",
        "scripts/source-preview.mjs",
        "--relocation",
        "overlay",
        "--fake-destructive",
        "--mutate",
        "s/assert\\.equal\\(sha256, expected\\.sha256,/assert.equal(expected.sha256, expected.sha256,/",
        "--test",
        "PROBE_SUBJECT={} PAPERCUSP_TEST_RUN_HARNESS=papercusp PAPERCUSP_WORKSPACE_ID=papercusp-workspace npm run test:file -- packages/operator-core/lib/release/operator-artifact.test.ts --testNamePattern=\"bg-r1-compiler-(dependency|immutable)\"",
        "--expect",
        "caught"
      ],
      "schemaVersion": 1,
      "cwd": ".",
      "runnerPath": "scripts/mutation-probe.sh",
      "result": {
        "baselineLedger": "test_runs:22576420",
        "guardExit": 1,
        "baselineExit": 0,
        "target": "copy-out",
        "verdict": "caught",
        "mutantLedger": "test_runs:22576428",
        "expected": "caught",
        "copyBaselineLedger": "test_runs:22576424",
        "assertionEvidence": "test-file-assertion-failure",
        "relocation": "overlay",
        "mutantParse": "ok"
      }
    }
  },
  "logs": {
    "/tmp/bg-host-p001-r1-source-custody-mutant-immutable-947da-20261028.log": {
      "sha256": "cc295a6ccdac314e696b3d778a97313e5f8b37f6a88b98ff54237c8204230985",
      "result": [
        "MUTATION_PROBE_RESULT verdict=caught expected=caught target=copy-out baseline_exit=0 guard_exit=1 mutant_parse=ok assertion_evidence=test-file-assertion-failure relocation=overlay baseline_ledger=test_runs:22576364 copy_baseline_ledger=test_runs:22576372 mutant_ledger=test_runs:22576405"
      ]
    },
    "/tmp/bg-host-p001-r1-dependency-custody-mutant-immutable-947da-20261028.log": {
      "sha256": "b56abb9b46e8b8a8aa35ba98a2d797c59ede662154ea9e57e0087ea21b682940",
      "result": [
        "MUTATION_PROBE_RESULT verdict=caught expected=caught target=copy-out baseline_exit=0 guard_exit=1 mutant_parse=ok assertion_evidence=test-file-assertion-failure relocation=overlay baseline_ledger=test_runs:22576420 copy_baseline_ledger=test_runs:22576424 mutant_ledger=test_runs:22576428"
      ]
    }
  },
  "originalAttempts": {
    "defaultReader": "/tmp/bg-host-p001-r1-source-custody-mutant-20261028.log: refused before tests (9071 reader lacks parser)",
    "mutableBaseline": "/tmp/bg-host-p001-r1-source-custody-mutant-current-20261028.log: baseline PASS but provenance UNKNOWN; no mutant executed",
    "audit": "Use current3170 reader and immutable947da snapshot; no timeout or assertion weakening."
  }
}

