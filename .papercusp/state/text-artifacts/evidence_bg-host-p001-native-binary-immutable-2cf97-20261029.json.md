---
rel_path: "evidence/bg-host-p001-native-binary-immutable-2cf97-20261029.json"
updated_at: 1793247055587
_body: "content"
---

{
  "schemaVersion": 1,
  "workItem": "WI-6554700010028547",
  "plan": "bg-host-committed-generation-2026-10-24",
  "scope": "Supplemental native compiler executable custody and bounded identity source proof. Current publication positive remains failed; P001 and Luna shipment are incomplete.",
  "commit": "2cf97b854d2758964f15aadbd865b9560e06daac",
  "keptRoot": "/tmp/pcv/papercusp-lint-as-committed-2cf97b854d-4LGSHn",
  "files": [
    {
      "path": "scripts/source-preview.mjs",
      "sha256": "1b7e681f17da472afb6ac1549d4d5bfb3284cfe0a07c978ad9dc4ecb32c81a36",
      "matchesCommitted": true
    },
    {
      "path": "scripts/source-preview.d.mts",
      "sha256": "72f7a7730430f25581ba43943a0b687210e556adc87b4ebfc31ab52856d4a212",
      "matchesCommitted": true
    },
    {
      "path": "packages/operator-core/lib/source-preview-export.test.ts",
      "sha256": "430c92d21588d4adbaca65918f98010218e1f2f7d7e98d0aa37ac3f32a458ca9",
      "matchesCommitted": true
    },
    {
      "path": "packages/operator-core/lib/source-preview.fixture.ts",
      "sha256": "0e40c96262275cc39f545dd1740173fb4e7a3eb3178f4872a84de8d73e4f540b",
      "matchesCommitted": true
    },
    {
      "path": "packages/operator-core/lib/blind-review-source-seal.ts",
      "sha256": "6ba330fb7515f01519844c9bfdfb887f4cf26c6dabee554e7640299f9f719667",
      "matchesCommitted": true
    },
    {
      "path": "packages/operator-core/lib/blind-review-source-seal.test.ts",
      "sha256": "c4f947b2b71f954d3297d1157c0e036dceaf59eee3d4e7d8589562b0a6269e70",
      "matchesCommitted": true
    },
    {
      "path": "apps/operator/bin/release/dependency-generation.sh",
      "sha256": "d6b1d1c06cba33d68ed31a5e5d9894655e1eca73c52adec38390489cf44b8f4e",
      "matchesCommitted": true
    },
    {
      "path": "apps/operator/bin/bundle-host.sh",
      "sha256": "629b480874315bbd181d41394f6af357c3e9561be4abf574647e0ea9d594fc75",
      "matchesCommitted": true
    },
    {
      "path": "scripts/mutation-probe.sh",
      "sha256": "e0eb6dc68a76e895e69343aca349cf8f549f6ae5d69a1c735b17ed9e9cb23c76",
      "matchesCommitted": true
    }
  ],
  "canonicalRuns": [
    {
      "id": "22605436",
      "filePath": "packages/operator-core/lib/source-preview-export.test.ts",
      "status": "fail",
      "source": "local",
      "commitSha": "2cf97b854d2758964f15aadbd865b9560e06daac",
      "worktreeDirty": false,
      "startedAt": "2026-10-29T03:59:26.217Z",
      "finishedAt": "2026-10-29T04:02:01.141Z",
      "root": "/tmp/pcv/papercusp-lint-as-committed-2cf97b854d-4LGSHn",
      "counts": {
        "passed": 10,
        "failed": 1,
        "skipped": 411
      },
      "testNamePattern": "BG compiler binary substitution|BG compiler API|compiles exact maintained host switches|runs the selected shared shell through the actual guarded CLI|BG toolchain identity hashes|BG recipe output-only mode|host retained kernel source seal",
      "collectionFailed": false,
      "passedCaseTitles": [
        "BG inherited manifest and original source boundaries > BG toolchain identity hashes every byte of a 0-byte file and refuses later tail drift",
        "BG inherited manifest and original source boundaries > BG toolchain identity hashes every byte of a 4194341-byte file and refuses later tail drift",
        "BG inherited manifest and original source boundaries > compiles exact maintained host switches using private real esbuild and retains original custody",
        "BG inherited manifest and original source boundaries > BG compiler API refuses substituted JavaScript before evaluation even when restored after import",
        "BG inherited manifest and original source boundaries > BG compiler API evaluates current accepted bytes independently of a stale Node module cache",
        "BG inherited manifest and original source boundaries > BG compiler binary substitution has no execution effect at bg.compiler.binary-seal even when restored",
        "BG inherited manifest and original source boundaries > BG compiler binary substitution has no execution effect at bg.compiler.build even when restored",
        "BG inherited manifest and original source boundaries > runs the selected shared shell through the actual guarded CLI and private pinned esbuild 0.25.0",
        "BG inherited manifest and original source boundaries > BG recipe output-only mode retains failed later compiler diagnostics without publishing or replaying a partial set",
        "BG inherited manifest and original source boundaries > BG recipe output-only mode requires its original publication destination before any build effect"
      ],
      "failedCaseTitles": [
        "BG inherited manifest and original source boundaries > BG recipe output-only mode compiles the original main and worker and publishes complete retained evidence"
      ],
      "mutation": null
    },
    {
      "id": "22605437",
      "filePath": "packages/operator-core/lib/blind-review-source-seal.test.ts",
      "status": "pass",
      "source": "local",
      "commitSha": "2cf97b854d2758964f15aadbd865b9560e06daac",
      "worktreeDirty": false,
      "startedAt": "2026-10-29T03:59:21.981Z",
      "finishedAt": "2026-10-29T03:59:22.390Z",
      "root": "/tmp/pcv/papercusp-lint-as-committed-2cf97b854d-4LGSHn",
      "counts": {
        "passed": 4,
        "failed": 0,
        "skipped": 0
      },
      "testNamePattern": "BG compiler binary substitution|BG compiler API|compiles exact maintained host switches|runs the selected shared shell through the actual guarded CLI|BG toolchain identity hashes|BG recipe output-only mode|host retained kernel source seal",
      "collectionFailed": false,
      "passedCaseTitles": [
        "host retained kernel source seal > retains the same sealed kernel object after exporter exit and refuses writes through reopened descriptors",
        "host retained kernel source seal > refuses wrong digest and a changed size before publishing a retained handle",
        "host retained kernel source seal > honors cancellation before starting an exporter",
        "host retained kernel source seal > loads through native Node ESM without the tsx loader"
      ],
      "mutation": null
    },
    {
      "id": "22605481",
      "filePath": "packages/operator-core/lib/source-preview-export.test.ts",
      "status": "pass",
      "source": "mutation-probe",
      "commitSha": "2cf97b854d2758964f15aadbd865b9560e06daac",
      "worktreeDirty": false,
      "startedAt": "2026-10-29T04:05:22.007Z",
      "finishedAt": "2026-10-29T04:05:46.363Z",
      "root": "/tmp/pcv/papercusp-lint-as-committed-2cf97b854d-4LGSHn",
      "counts": {
        "passed": 2,
        "failed": 0,
        "skipped": 420
      },
      "testNamePattern": "BG compiler binary substitution has no execution effect at bg.compiler.build|compiles exact maintained host switches",
      "collectionFailed": false,
      "passedCaseTitles": [
        "BG inherited manifest and original source boundaries > compiles exact maintained host switches using private real esbuild and retains original custody",
        "BG inherited manifest and original source boundaries > BG compiler binary substitution has no execution effect at bg.compiler.build even when restored"
      ],
      "mutation": {
        "leg": "baseline",
        "mode": "copy-out",
        "mutantDiff": "--- a/scripts/source-preview.mjs\n+++ b/scripts/source-preview.mjs\n@@ -1935,7 +1935,7 @@\n             // fd 3 is explicitly inherited by the child. The pathname chosen by\n             // esbuild stays bound above, but exec consumes the sealed A bytes even\n             // if that original pathname temporarily names B during service startup.\n-            return spawn('/proc/self/fd/3', args, { ...spawnOptions,\n+            return spawn(binary.realpath, args, { ...spawnOptions,\n               env: { ...invocation.environment }, stdio: ['pipe', 'pipe', 'inherit', retainedBinary.fd] });\n           },\n         };\n",
        "subjectPath": "scripts/source-preview.mjs",
        "testCommand": "PROBE_SUBJECT={} PAPERCUSP_TEST_RUN_HARNESS=papercusp PAPERCUSP_WORKSPACE_ID=papercusp-workspace npm run test:file -- packages/operator-core/lib/source-preview-export.test.ts --testNamePattern='BG compiler binary substitution has no execution effect at bg.compiler.build|compiles exact maintained host switches'",
        "againstCommit": null,
        "schemaVersion": 1,
        "testFileSha256": "430c92d21588d4adbaca65918f98010218e1f2f7d7e98d0aa37ac3f32a458ca9",
        "mutateExpression": "s#return spawn\\('/proc/self/fd/3', args, \\{ \\.\\.\\.spawnOptions,#return spawn(binary.realpath, args, { ...spawnOptions,#",
        "probeInvocationId": "e4d32f23-0973-4b44-a821-34691a2350f1",
        "testCommandSha256": "bf9b528e053daf128c815dec53536e0711e4e868815ed44f0c776f1ee9479729",
        "subjectAfterSha256": "f58b68d2e16b3ff14e9ccdb62592d789f0d470c18d2733e64605869484c3ceb4",
        "mutantDiffTruncated": false,
        "subjectBeforeSha256": "1b7e681f17da472afb6ac1549d4d5bfb3284cfe0a07c978ad9dc4ecb32c81a36"
      }
    },
    {
      "id": "22606965",
      "filePath": "packages/operator-core/lib/source-preview-export.test.ts",
      "status": "pass",
      "source": "mutation-probe",
      "commitSha": "2cf97b854d2758964f15aadbd865b9560e06daac",
      "worktreeDirty": false,
      "startedAt": "2026-10-29T04:07:22.319Z",
      "finishedAt": "2026-10-29T04:07:37.469Z",
      "root": "/tmp/pcv/papercusp-lint-as-committed-2cf97b854d-4LGSHn",
      "counts": {
        "passed": 2,
        "failed": 0,
        "skipped": 420
      },
      "testNamePattern": "BG compiler binary substitution has no execution effect at bg.compiler.build|compiles exact maintained host switches",
      "collectionFailed": false,
      "passedCaseTitles": [
        "BG inherited manifest and original source boundaries > compiles exact maintained host switches using private real esbuild and retains original custody",
        "BG inherited manifest and original source boundaries > BG compiler binary substitution has no execution effect at bg.compiler.build even when restored"
      ],
      "mutation": {
        "leg": "copy-baseline",
        "mode": "copy-out",
        "mutantDiff": "--- a/scripts/source-preview.mjs\n+++ b/scripts/source-preview.mjs\n@@ -1935,7 +1935,7 @@\n             // fd 3 is explicitly inherited by the child. The pathname chosen by\n             // esbuild stays bound above, but exec consumes the sealed A bytes even\n             // if that original pathname temporarily names B during service startup.\n-            return spawn('/proc/self/fd/3', args, { ...spawnOptions,\n+            return spawn(binary.realpath, args, { ...spawnOptions,\n               env: { ...invocation.environment }, stdio: ['pipe', 'pipe', 'inherit', retainedBinary.fd] });\n           },\n         };\n",
        "subjectPath": "scripts/source-preview.mjs",
        "testCommand": "PROBE_SUBJECT={} PAPERCUSP_TEST_RUN_HARNESS=papercusp PAPERCUSP_WORKSPACE_ID=papercusp-workspace npm run test:file -- packages/operator-core/lib/source-preview-export.test.ts --testNamePattern='BG compiler binary substitution has no execution effect at bg.compiler.build|compiles exact maintained host switches'",
        "againstCommit": null,
        "schemaVersion": 1,
        "testFileSha256": "430c92d21588d4adbaca65918f98010218e1f2f7d7e98d0aa37ac3f32a458ca9",
        "mutateExpression": "s#return spawn\\('/proc/self/fd/3', args, \\{ \\.\\.\\.spawnOptions,#return spawn(binary.realpath, args, { ...spawnOptions,#",
        "probeInvocationId": "e4d32f23-0973-4b44-a821-34691a2350f1",
        "testCommandSha256": "bf9b528e053daf128c815dec53536e0711e4e868815ed44f0c776f1ee9479729",
        "subjectAfterSha256": "f58b68d2e16b3ff14e9ccdb62592d789f0d470c18d2733e64605869484c3ceb4",
        "mutantDiffTruncated": false,
        "subjectBeforeSha256": "1b7e681f17da472afb6ac1549d4d5bfb3284cfe0a07c978ad9dc4ecb32c81a36"
      }
    },
    {
      "id": "22606972",
      "filePath": "packages/operator-core/lib/source-preview-export.test.ts",
      "status": "fail",
      "source": "mutation-probe",
      "commitSha": "2cf97b854d2758964f15aadbd865b9560e06daac",
      "worktreeDirty": false,
      "startedAt": "2026-10-29T04:08:38.016Z",
      "finishedAt": "2026-10-29T04:08:53.699Z",
      "root": "/tmp/pcv/papercusp-lint-as-committed-2cf97b854d-4LGSHn",
      "counts": {
        "passed": 1,
        "failed": 1,
        "skipped": 420
      },
      "testNamePattern": "BG compiler binary substitution has no execution effect at bg.compiler.build|compiles exact maintained host switches",
      "collectionFailed": false,
      "passedCaseTitles": [
        "BG inherited manifest and original source boundaries > compiles exact maintained host switches using private real esbuild and retains original custody"
      ],
      "failedCaseTitles": [
        "BG inherited manifest and original source boundaries > BG compiler binary substitution has no execution effect at bg.compiler.build even when restored"
      ],
      "mutation": {
        "leg": "mutant",
        "mode": "copy-out",
        "mutantDiff": "--- a/scripts/source-preview.mjs\n+++ b/scripts/source-preview.mjs\n@@ -1935,7 +1935,7 @@\n             // fd 3 is explicitly inherited by the child. The pathname chosen by\n             // esbuild stays bound above, but exec consumes the sealed A bytes even\n             // if that original pathname temporarily names B during service startup.\n-            return spawn('/proc/self/fd/3', args, { ...spawnOptions,\n+            return spawn(binary.realpath, args, { ...spawnOptions,\n               env: { ...invocation.environment }, stdio: ['pipe', 'pipe', 'inherit', retainedBinary.fd] });\n           },\n         };\n",
        "subjectPath": "scripts/source-preview.mjs",
        "testCommand": "PROBE_SUBJECT={} PAPERCUSP_TEST_RUN_HARNESS=papercusp PAPERCUSP_WORKSPACE_ID=papercusp-workspace npm run test:file -- packages/operator-core/lib/source-preview-export.test.ts --testNamePattern='BG compiler binary substitution has no execution effect at bg.compiler.build|compiles exact maintained host switches'",
        "againstCommit": null,
        "schemaVersion": 1,
        "testFileSha256": "430c92d21588d4adbaca65918f98010218e1f2f7d7e98d0aa37ac3f32a458ca9",
        "mutateExpression": "s#return spawn\\('/proc/self/fd/3', args, \\{ \\.\\.\\.spawnOptions,#return spawn(binary.realpath, args, { ...spawnOptions,#",
        "probeInvocationId": "e4d32f23-0973-4b44-a821-34691a2350f1",
        "testCommandSha256": "bf9b528e053daf128c815dec53536e0711e4e868815ed44f0c776f1ee9479729",
        "subjectAfterSha256": "f58b68d2e16b3ff14e9ccdb62592d789f0d470c18d2733e64605869484c3ceb4",
        "mutantDiffTruncated": false,
        "subjectBeforeSha256": "1b7e681f17da472afb6ac1549d4d5bfb3284cfe0a07c978ad9dc4ecb32c81a36"
      }
    }
  ],
  "caseLedgerVerification": {
    "population": [
      22605436,
      22605437,
      22605481,
      22606965,
      22606972
    ],
    "nonSkippedCases": [
      {
        "test_run_id": "22605436",
        "case_index": 254,
        "case_key": "BG inherited manifest and original source boundaries > BG toolchain identity hashes every byte of a 0-byte file and refuses later tail drift",
        "status": "pass",
        "error_tail": null
      },
      {
        "test_run_id": "22605436",
        "case_index": 255,
        "case_key": "BG inherited manifest and original source boundaries > BG toolchain identity hashes every byte of a 4194341-byte file and refuses later tail drift",
        "status": "pass",
        "error_tail": null
      },
      {
        "test_run_id": "22605436",
        "case_index": 256,
        "case_key": "BG inherited manifest and original source boundaries > compiles exact maintained host switches using private real esbuild and retains original custody",
        "status": "pass",
        "error_tail": null
      },
      {
        "test_run_id": "22605436",
        "case_index": 257,
        "case_key": "BG inherited manifest and original source boundaries > BG compiler API refuses substituted JavaScript before evaluation even when restored after import",
        "status": "pass",
        "error_tail": null
      },
      {
        "test_run_id": "22605436",
        "case_index": 258,
        "case_key": "BG inherited manifest and original source boundaries > BG compiler API evaluates current accepted bytes independently of a stale Node module cache",
        "status": "pass",
        "error_tail": null
      },
      {
        "test_run_id": "22605436",
        "case_index": 259,
        "case_key": "BG inherited manifest and original source boundaries > BG compiler binary substitution has no execution effect at bg.compiler.binary-seal even when restored",
        "status": "pass",
        "error_tail": null
      },
      {
        "test_run_id": "22605436",
        "case_index": 260,
        "case_key": "BG inherited manifest and original source boundaries > BG compiler binary substitution has no execution effect at bg.compiler.build even when restored",
        "status": "pass",
        "error_tail": null
      },
      {
        "test_run_id": "22605436",
        "case_index": 268,
        "case_key": "BG inherited manifest and original source boundaries > runs the selected shared shell through the actual guarded CLI and private pinned esbuild 0.25.0",
        "status": "pass",
        "error_tail": null
      },
      {
        "test_run_id": "22605436",
        "case_index": 269,
        "case_key": "BG inherited manifest and original source boundaries > BG recipe output-only mode compiles the original main and worker and publishes complete retained evidence",
        "status": "fail",
        "error_tail": "Test timed out in 60000ms.\nIf this is a long-running test, pass a timeout value as the last argument or configure it globally with \"testTimeout\"."
      },
      {
        "test_run_id": "22605436",
        "case_index": 294,
        "case_key": "BG inherited manifest and original source boundaries > BG recipe output-only mode retains failed later compiler diagnostics without publishing or replaying a partial set",
        "status": "pass",
        "error_tail": null
      },
      {
        "test_run_id": "22605436",
        "case_index": 295,
        "case_key": "BG inherited manifest and original source boundaries > BG recipe output-only mode requires its original publication destination before any build effect",
        "status": "pass",
        "error_tail": null
      },
      {
        "test_run_id": "22605437",
        "case_index": 0,
        "case_key": "host retained kernel source seal > retains the same sealed kernel object after exporter exit and refuses writes through reopened descriptors",
        "status": "pass",
        "error_tail": null
      },
      {
        "test_run_id": "22605437",
        "case_index": 1,
        "case_key": "host retained kernel source seal > refuses wrong digest and a changed size before publishing a retained handle",
        "status": "pass",
        "error_tail": null
      },
      {
        "test_run_id": "22605437",
        "case_index": 2,
        "case_key": "host retained kernel source seal > honors cancellation before starting an exporter",
        "status": "pass",
        "error_tail": null
      },
      {
        "test_run_id": "22605437",
        "case_index": 3,
        "case_key": "host retained kernel source seal > loads through native Node ESM without the tsx loader",
        "status": "pass",
        "error_tail": null
      },
      {
        "test_run_id": "22605481",
        "case_index": 256,
        "case_key": "BG inherited manifest and original source boundaries > compiles exact maintained host switches using private real esbuild and retains original custody",
        "status": "pass",
        "error_tail": null
      },
      {
        "test_run_id": "22605481",
        "case_index": 260,
        "case_key": "BG inherited manifest and original source boundaries > BG compiler binary substitution has no execution effect at bg.compiler.build even when restored",
        "status": "pass",
        "error_tail": null
      },
      {
        "test_run_id": "22606965",
        "case_index": 256,
        "case_key": "BG inherited manifest and original source boundaries > compiles exact maintained host switches using private real esbuild and retains original custody",
        "status": "pass",
        "error_tail": null
      },
      {
        "test_run_id": "22606965",
        "case_index": 260,
        "case_key": "BG inherited manifest and original source boundaries > BG compiler binary substitution has no execution effect at bg.compiler.build even when restored",
        "status": "pass",
        "error_tail": null
      },
      {
        "test_run_id": "22606972",
        "case_index": 256,
        "case_key": "BG inherited manifest and original source boundaries > compiles exact maintained host switches using private real esbuild and retains original custody",
        "status": "pass",
        "error_tail": null
      },
      {
        "test_run_id": "22606972",
        "case_index": 260,
        "case_key": "BG inherited manifest and original source boundaries > BG compiler binary substitution has no execution effect at bg.compiler.build even when restored",
        "status": "fail",
        "error_tail": "substituted native binary must have no execution effect: expected true to be false // Object.is equality\nactual: true\nexpected: false"
      }
    ],
    "expected": {
      "22605436": {
        "pass": 10,
        "fail": 1
      },
      "22605437": {
        "pass": 4,
        "fail": 0
      },
      "22605481": {
        "pass": 2,
        "fail": 0
      },
      "22606965": {
        "pass": 2,
        "fail": 0
      },
      "22606972": {
        "pass": 1,
        "fail": 1
      }
    },
    "residue": [
      "EI-27278644631334590"
    ]
  },
  "caseLedgerQuery": "SELECT c.test_run_id,c.case_index,c.case_key,c.status,c.error_tail FROM harness_shared.test_case_runs c JOIN harness_shared.test_runs r ON r.id=c.test_run_id WHERE r.workspace_id='papercusp-workspace' AND r.harness_slug='papercusp' AND c.test_run_id IN (22605436,22605437,22605481,22606965,22606972) AND c.status<>'skip' ORDER BY c.test_run_id,c.case_index",
  "mutationEvidence": {
    "cwd": ".",
    "argv": [
      "--file",
      "scripts/source-preview.mjs",
      "--relocation",
      "overlay",
      "--fake-destructive",
      "--mutate",
      "s#return spawn\\('/proc/self/fd/3', args, \\{ \\.\\.\\.spawnOptions,#return spawn(binary.realpath, args, { ...spawnOptions,#",
      "--test",
      "PROBE_SUBJECT={} PAPERCUSP_TEST_RUN_HARNESS=papercusp PAPERCUSP_WORKSPACE_ID=papercusp-workspace npm run test:file -- packages/operator-core/lib/source-preview-export.test.ts --testNamePattern='BG compiler binary substitution has no execution effect at bg.compiler.build|compiles exact maintained host switches'",
      "--expect",
      "caught"
    ],
    "environment": {
      "PAPERCUSP_MUTATION_DESCRIPTOR_READER_REQUIRED": 1,
      "PAPERCUSP_MUTATION_DESCRIPTOR_READER_HEALTH_URL": "http://127.0.0.1:3170/api/health",
      "PAPERCUSP_MUTATION_DESCRIPTOR_READER_REPO": "/tmp/pcv/papercusp-lint-as-committed-2cf97b854d-4LGSHn",
      "PAPERCUSP_TEST_RUN_HARNESS": "papercusp",
      "PAPERCUSP_MUTATION_DESCRIPTOR_EXPORT": "auto"
    },
    "runnerCommit": "2cf97b854d2758964f15aadbd865b9560e06daac",
    "runnerPath": "scripts/mutation-probe.sh",
    "result": {
      "verdict": "caught",
      "baselineExit": 0,
      "guardExit": 1,
      "mutantLedger": "test_runs:22606972",
      "mutantParse": "ok",
      "assertionEvidence": "test-file-assertion-failure",
      "baselineLedger": "test_runs:22605481",
      "relocation": "overlay",
      "target": "copy-out",
      "expected": "caught",
      "copyBaselineLedger": "test_runs:22606965"
    },
    "runnerSha256": "e0eb6dc68a76e895e69343aca349cf8f549f6ae5d69a1c735b17ed9e9cb23c76",
    "schemaVersion": 1
  },
  "mutationVerification": {
    "parse": "ok",
    "baselinePass": true,
    "copyBaselinePass": true,
    "ordinaryPositivePassUnderMutant": true,
    "decisiveNegative": {
      "test_run_id": "22606972",
      "case_index": 260,
      "case_key": "BG inherited manifest and original source boundaries > BG compiler binary substitution has no execution effect at bg.compiler.build even when restored",
      "status": "fail",
      "error_tail": "substituted native binary must have no execution effect: expected true to be false // Object.is equality\nactual: true\nexpected: false"
    },
    "containment": "contained",
    "treeIntegrity": "VERIFIED",
    "childSourceSubstituted": 0
  },
  "rootCauseVerification": {
    "hypothesis": "Executing the validated retained sealed descriptor prevents a substituted original native executable path from having any effect during compiler service startup.",
    "alternativeHypothesis": "The refusal comes only from a later identity fence; executing the original mutable pathname is equally safe.",
    "distinguishingTest": "Change only return spawn('/proc/self/fd/3', args, {...spawnOptions to return spawn(binary.realpath, args, {...spawnOptions in the private overlay. Run actual bg.compiler.build A-to-B-to-A substitution plus the ordinary maintained real compilation.",
    "predictedObservations": {
      "hypothesis": "Unmutated baselines pass both cases; mutant creates the substitution sentinel and fails the no-effect assertion while ordinary compilation still passes.",
      "alternativeHypothesis": "Mutable-path mutant also preserves no-effect refusal; both cases pass."
    },
    "actualObservation": "Baseline22605481 and copy22606965 each PASS2. Mutant22606972 ordinary compiler PASS; exact substitution row FAIL: substituted native binary must have no execution effect: expected true to be false // Object.is equality\nactual: true\nexpected: false",
    "evidenceRefs": [
      "test_runs:22605481",
      "test_runs:22606965",
      "test_runs:22606972"
    ]
  },
  "publicationResidue": {
    "id": "EI-27278644631334590",
    "assignee": "su-ebe9b9b1-f43d-4eb4-839d-e281da578e4b",
    "sourceRun": "22605436",
    "caseIndex": 269,
    "status": "fail",
    "cause": "Unconfirmed; unchanged 60000ms case deadline exceeded",
    "evidencePosted": "thread-post:1210065",
    "peerNotification": "coord-send-d7f08f50ab89073de48925945afca59eff31e82504ccd0d4596e3227ab1bdc17"
  },
  "logs": [
    {
      "path": "/tmp/bg-p001-native-binary-immutable-2cf97-ledger-20261029.log",
      "sha256": "65b8ef6186f42779266b0b0a989a7b6585aaf4d40ac3c8ddf6913ef0cf89a352",
      "nativeSession": 77248,
      "exitCode": 1,
      "provenanceSummary": "TEST_FILE_RESULT requested=2 executed=2 matched=2 status=failed head=2cf97b854d uncommittedPaths=0/2 provenance=stamped startedAt=2026-10-29T03:59:10.126Z childSubstituted=0 skippedTests=411"
    },
    {
      "path": "/tmp/bg-p001-native-fdspawn-mutation-2cf97-20261029.log",
      "sha256": "c112da1f7b1037fb462fc91a228ec14feb49a7fa9be6fc6410cd71201e535d65",
      "nativeSession": 22033,
      "exitCode": 0,
      "result": "MUTATION_PROBE_RESULT verdict=caught expected=caught target=copy-out baseline_exit=0 guard_exit=1 mutant_parse=ok assertion_evidence=test-file-assertion-failure relocation=overlay baseline_ledger=test_runs:22605481 copy_baseline_ledger=test_runs:22606965 mutant_ledger=test_runs:22606972",
      "containment": "MUTATION_PROBE_CONTAINMENT status=contained overlays=1 uncovered=0 failed=0",
      "treeIntegrity": "[mutation-probe] tree integrity: VERIFIED — /tmp/pcv/papercusp-lint-as-committed-2cf97b854d-4LGSHn/scripts/source-preview.mjs is byte-identical to its pre-probe state"
    }
  ],
  "syntax": {
    "command": "node --check scripts/source-preview.mjs",
    "exitCode": 0
  },
  "limitations": [
    "This is source-plane supplemental proof, not actual service readiness, native operational acceptance or shipment.",
    "The combined immutable run is FAIL:14 passing cases and one publication-positive timeout. No green whole-unit claim.",
    "Original authoritative sole-producer source/artifact/boot/parent packet remains UNKNOWN and forbids actual preparation/activation.",
    "R1 exact required population census, full runtime/R4/P002/P003 and independent acceptance remain open.",
    "Prior API/source proofs are preserved by their exact bound fingerprints; no passing matrix was replayed solely to reconstruct evidence.",
    "No LIVE_GATE_OPS action, timeout widening, validation cache, skip/quarantine, foreign hold override, additional implementation worker, or source edit was performed."
  ]
}

