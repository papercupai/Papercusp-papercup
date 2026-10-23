---
rel_path: "audits/parked-agent-resumption-2026-10-09/resume204-retained-proof-reuse-and-command-diagnostic-design-424d5.json"
updated_at: 1792711520396
_body: "content"
---

{
  "schemaVersion": 1,
  "at": "2026-10-22T23:25:08.516813+00:00",
  "ownerId": "su-424d5476-0b13-401a-a926-0aaa9f212391",
  "priorArchive": "audits/parked-agent-resumption-2026-10-09/resume203-sidecar-custody-and-draft-adequacy-424d5.json",
  "priorVerifiedSha256": "fd7e2eda5946bc845089776d30dc838457232fc72dce8b168c56add5d413a1dc",
  "records": {
    "binding-result": {
      "ok": false,
      "results": [
        {
          "ok": false,
          "slug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
          "error": "test_run_source_modified_after_run",
          "fromTestRun": 21784912,
          "message": "test-run 21784912 started at 2026-10-22T21:09:57.885Z, but packages/operator-core/lib/scheduler/fleet-scope-admission.test.ts was modified at 2026-10-22T21:50:19.461Z, so the binding would fingerprint bytes this run may never have executed. Re-run the test and bind the new run."
        },
        {
          "ok": false,
          "slug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
          "error": "test_run_source_modified_after_run",
          "fromTestRun": 21784912,
          "message": "test-run 21784912 started at 2026-10-22T21:09:57.885Z, but packages/operator-core/lib/scheduler/fleet-scope-admission.test.ts was modified at 2026-10-22T21:50:19.461Z, so the binding would fingerprint bytes this run may never have executed. Re-run the test and bind the new run."
        },
        {
          "ok": false,
          "slug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
          "error": "test_run_source_modified_after_run",
          "fromTestRun": 21784912,
          "message": "test-run 21784912 started at 2026-10-22T21:09:57.885Z, but packages/operator-core/lib/scheduler/fleet-scope-admission.test.ts was modified at 2026-10-22T21:50:19.461Z, so the binding would fingerprint bytes this run may never have executed. Re-run the test and bind the new run."
        },
        {
          "ok": true,
          "slug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
          "derivedFromTestRun": {
            "testRunId": 21784916,
            "evidenceKind": "test",
            "evidenceRef": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
            "measurement": {
              "schemaVersion": 1,
              "kind": "repo-files",
              "sourcePaths": [
                "apps/operator/scripts/psu-pty-host.mjs"
              ],
              "testPaths": [
                "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts"
              ]
            },
            "harnessAttribution": "run"
          },
          "status": "created",
          "id": 65302,
          "workItemId": "WI-6554700010008887",
          "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
          "specId": "AUTO-BAR-R-28-P-012",
          "sourceValId": null,
          "specRevision": 1,
          "specFingerprint": "e7f2e78332c5e9377bc89e2e949b9d4bd39b4a8fa60a074d4b16dcdb9510ab50",
          "bindingFingerprint": "7c5776e93333be84c6f86c48648453a56ac05cf42d18c577365b93ad15b127a8",
          "advisory": {
            "code": "duplicate_live_test_run_bindings",
            "testRunId": 21784916,
            "bindingIds": [
              65278
            ],
            "message": "Test run 21784916 is already live in binding(s) 65278 for test evidence 'apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts' on AUTO-BAR-R-28-P-012@1. This new binding remains live as well. If it replaces the earlier proof, re-bind with supersedeAtRevision:true; otherwise retract the stale binding(s) with plans:bind-spec-evidence retract."
          }
        },
        {
          "ok": true,
          "slug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
          "derivedFromTestRun": {
            "testRunId": 21784916,
            "evidenceKind": "test",
            "evidenceRef": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
            "measurement": {
              "schemaVersion": 1,
              "kind": "repo-files",
              "sourcePaths": [
                "apps/operator/scripts/psu-pty-host.mjs"
              ],
              "testPaths": [
                "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts"
              ]
            },
            "harnessAttribution": "run"
          },
          "status": "created",
          "id": 65303,
          "workItemId": "WI-6554700010008887",
          "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
          "specId": "AUTO-BAR-R-28-P-004",
          "sourceValId": null,
          "specRevision": 1,
          "specFingerprint": "3fea0b2cd75a6671d1cef8b490c8359c5ed4670083b6bf78417653c8b85acf3c",
          "bindingFingerprint": "48c5824bdf4f3c8680fbe4f36ef77d5f0b36ec0224b1dbf15189bbd54422dfb6",
          "advisory": {
            "code": "duplicate_live_test_run_bindings",
            "testRunId": 21784916,
            "bindingIds": [
              65277
            ],
            "message": "Test run 21784916 is already live in binding(s) 65277 for test evidence 'apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts' on AUTO-BAR-R-28-P-004@1. This new binding remains live as well. If it replaces the earlier proof, re-bind with supersedeAtRevision:true; otherwise retract the stale binding(s) with plans:bind-spec-evidence retract."
          }
        },
        {
          "ok": true,
          "slug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
          "derivedFromTestRun": {
            "testRunId": 21338043,
            "evidenceKind": "test",
            "evidenceRef": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
            "measurement": {
              "schemaVersion": 1,
              "kind": "repo-files",
              "sourcePaths": [
                "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
                "packages/operator-core/lib/scheduler/fleet-scope-admission.ts"
              ],
              "testPaths": [
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts"
              ],
              "fixturePaths": [
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts"
              ],
              "runtimeUnits": [
                "llm-test-in-process-959721"
              ],
              "completedRuntime": {
                "kind": "llm-in-process"
              }
            },
            "harnessAttribution": "run"
          },
          "status": "created",
          "id": 65304,
          "workItemId": "WI-6554700010008887",
          "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
          "specId": "AUTO-BAR-R-32-P-008",
          "sourceValId": null,
          "specRevision": 1,
          "specFingerprint": "53994729feb67fccdbf6a2616898d415aa8e167ac1eb3cbbc0f100524e08cdd9",
          "bindingFingerprint": "2dbfd61abb736fb4055f79f7f66c6b501d0fa0595a75393f15979fe8ddc7cd21"
        },
        {
          "ok": true,
          "slug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
          "derivedFromTestRun": {
            "testRunId": 21338029,
            "evidenceKind": "test",
            "evidenceRef": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
            "measurement": {
              "schemaVersion": 1,
              "kind": "repo-files",
              "sourcePaths": [
                "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
                "packages/operator-core/lib/scheduler/fleet-scope-admission.ts"
              ],
              "testPaths": [
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts"
              ],
              "fixturePaths": [
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts"
              ],
              "runtimeUnits": [
                "llm-test-in-process-959628"
              ],
              "completedRuntime": {
                "kind": "llm-in-process"
              }
            },
            "harnessAttribution": "run"
          },
          "status": "created",
          "id": 65305,
          "workItemId": "WI-6554700010008887",
          "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
          "specId": "AUTO-BAR-R-32-P-008",
          "sourceValId": null,
          "specRevision": 1,
          "specFingerprint": "53994729feb67fccdbf6a2616898d415aa8e167ac1eb3cbbc0f100524e08cdd9",
          "bindingFingerprint": "a72f1484b858f88c2d8daaa4c8c27a3936f826b3a9eed8773669f51ffbe86b5b"
        },
        {
          "ok": true,
          "slug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
          "derivedFromTestRun": {
            "testRunId": 21338041,
            "evidenceKind": "test",
            "evidenceRef": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
            "measurement": {
              "schemaVersion": 1,
              "kind": "repo-files",
              "sourcePaths": [
                "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
                "packages/operator-core/lib/scheduler/fleet-scope-admission.ts"
              ],
              "testPaths": [
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts"
              ],
              "fixturePaths": [
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts"
              ],
              "runtimeUnits": [
                "llm-test-in-process-959719"
              ],
              "completedRuntime": {
                "kind": "llm-in-process"
              }
            },
            "harnessAttribution": "run"
          },
          "status": "created",
          "id": 65306,
          "workItemId": "WI-6554700010008887",
          "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
          "specId": "AUTO-BAR-R-34-P-008",
          "sourceValId": null,
          "specRevision": 1,
          "specFingerprint": "c0b85504df60ba7f2ca47a4f3bd9249eeb9258d6e18d9f24474f052ab6fb987d",
          "bindingFingerprint": "ec2b83378a887a62566234ec1f462691ed74482773d2d8caa55e9308927fade7"
        },
        {
          "ok": true,
          "slug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
          "derivedFromTestRun": {
            "testRunId": 21338040,
            "evidenceKind": "test",
            "evidenceRef": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
            "measurement": {
              "schemaVersion": 1,
              "kind": "repo-files",
              "sourcePaths": [
                "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
                "packages/operator-core/lib/scheduler/fleet-scope-admission.ts"
              ],
              "testPaths": [
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts"
              ],
              "fixturePaths": [
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts"
              ],
              "runtimeUnits": [
                "llm-test-in-process-959660"
              ],
              "completedRuntime": {
                "kind": "llm-in-process"
              }
            },
            "harnessAttribution": "run"
          },
          "status": "created",
          "id": 65307,
          "workItemId": "WI-6554700010008887",
          "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
          "specId": "AUTO-BAR-R-33-P-008",
          "sourceValId": null,
          "specRevision": 1,
          "specFingerprint": "b14f5695f8fad63f9724bbd5ab3d125673e8c4b0f5b3b4a491eaaead6dd0c8de",
          "bindingFingerprint": "74dfa45516752df32a7fc8d70cad4a94b721585ae03236db0d5b854372c164dd"
        },
        {
          "ok": true,
          "slug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
          "derivedFromTestRun": {
            "testRunId": 21338017,
            "evidenceKind": "test",
            "evidenceRef": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
            "measurement": {
              "schemaVersion": 1,
              "kind": "repo-files",
              "sourcePaths": [
                "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
                "packages/operator-core/lib/scheduler/fleet-scope-admission.ts"
              ],
              "testPaths": [
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts"
              ],
              "fixturePaths": [
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts"
              ]
            },
            "harnessAttribution": "run"
          },
          "status": "created",
          "id": 65308,
          "workItemId": "WI-6554700010008887",
          "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
          "specId": "AUTO-BAR-R-32-P-008",
          "sourceValId": null,
          "specRevision": 1,
          "specFingerprint": "53994729feb67fccdbf6a2616898d415aa8e167ac1eb3cbbc0f100524e08cdd9",
          "bindingFingerprint": "27f412c168433fc84e1d48beb153b7ab12a2b28bee4c6b5410b356e2cd881a2b"
        },
        {
          "ok": true,
          "slug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
          "derivedFromTestRun": {
            "testRunId": 21338017,
            "evidenceKind": "test",
            "evidenceRef": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
            "measurement": {
              "schemaVersion": 1,
              "kind": "repo-files",
              "sourcePaths": [
                "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
                "packages/operator-core/lib/scheduler/fleet-scope-admission.ts"
              ],
              "testPaths": [
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts"
              ],
              "fixturePaths": [
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts"
              ]
            },
            "harnessAttribution": "run"
          },
          "status": "created",
          "id": 65309,
          "workItemId": "WI-6554700010008887",
          "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
          "specId": "AUTO-BAR-R-32-P-008",
          "sourceValId": null,
          "specRevision": 1,
          "specFingerprint": "53994729feb67fccdbf6a2616898d415aa8e167ac1eb3cbbc0f100524e08cdd9",
          "bindingFingerprint": "6511ab0e23d6115dbfe5a59d7712f734e9fb8e111444138dc96feafc1715257f",
          "advisory": {
            "code": "duplicate_live_test_run_bindings",
            "testRunId": 21338017,
            "bindingIds": [
              65308
            ],
            "message": "Test run 21338017 is already live in binding(s) 65308 for test evidence 'packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts' on AUTO-BAR-R-32-P-008@1. This new binding remains live as well. If it replaces the earlier proof, re-bind with supersedeAtRevision:true; otherwise retract the stale binding(s) with plans:bind-spec-evidence retract."
          }
        },
        {
          "ok": true,
          "slug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
          "derivedFromTestRun": {
            "testRunId": 21338017,
            "evidenceKind": "test",
            "evidenceRef": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
            "measurement": {
              "schemaVersion": 1,
              "kind": "repo-files",
              "sourcePaths": [
                "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
                "packages/operator-core/lib/scheduler/fleet-scope-admission.ts"
              ],
              "testPaths": [
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts"
              ],
              "fixturePaths": [
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts"
              ]
            },
            "harnessAttribution": "run"
          },
          "status": "created",
          "id": 65310,
          "workItemId": "WI-6554700010008887",
          "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
          "specId": "AUTO-BAR-R-34-P-008",
          "sourceValId": null,
          "specRevision": 1,
          "specFingerprint": "c0b85504df60ba7f2ca47a4f3bd9249eeb9258d6e18d9f24474f052ab6fb987d",
          "bindingFingerprint": "444e44b92723e434d0dd95136fa4629e27729b7281c9891594ad0f8953f41bc6"
        },
        {
          "ok": true,
          "slug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
          "derivedFromTestRun": {
            "testRunId": 21338017,
            "evidenceKind": "test",
            "evidenceRef": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
            "measurement": {
              "schemaVersion": 1,
              "kind": "repo-files",
              "sourcePaths": [
                "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
                "packages/operator-core/lib/scheduler/fleet-scope-admission.ts"
              ],
              "testPaths": [
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts"
              ],
              "fixturePaths": [
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts"
              ]
            },
            "harnessAttribution": "run"
          },
          "status": "created",
          "id": 65311,
          "workItemId": "WI-6554700010008887",
          "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
          "specId": "AUTO-BAR-R-33-P-008",
          "sourceValId": null,
          "specRevision": 1,
          "specFingerprint": "b14f5695f8fad63f9724bbd5ab3d125673e8c4b0f5b3b4a491eaaead6dd0c8de",
          "bindingFingerprint": "e55273f238bb48c3e641ec7f31ea4cee09f78f8b8ff58965e5e8c23546726c6c"
        },
        {
          "ok": false,
          "slug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
          "error": "test_run_canonical_path_mismatch",
          "fromTestRun": 21338051,
          "message": "canonicalTestPath \"test-run 21338051 mutation-probe mutant fail packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts @7a0aea1229ad\" does not preserve mutation-probe run 21338051's recorded relative test path \"packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"."
        },
        {
          "ok": false,
          "slug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
          "error": "test_run_canonical_path_mismatch",
          "fromTestRun": 21338076,
          "message": "canonicalTestPath \"test-run 21338076 mutation-probe mutant fail packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts @7a0aea1229ad\" does not preserve mutation-probe run 21338076's recorded relative test path \"packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"."
        },
        {
          "ok": false,
          "slug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
          "error": "test_run_canonical_path_mismatch",
          "fromTestRun": 21338077,
          "message": "canonicalTestPath \"test-run 21338077 mutation-probe mutant fail packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts @7a0aea1229ad\" does not preserve mutation-probe run 21338077's recorded relative test path \"packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"."
        },
        {
          "ok": false,
          "slug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
          "error": "test_run_canonical_path_mismatch",
          "fromTestRun": 21338047,
          "message": "canonicalTestPath \"test-run 21338047 mutation-probe mutant fail packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts @7a0aea1229ad\" does not preserve mutation-probe run 21338047's recorded relative test path \"packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts\"."
        }
      ],
      "counts": {
        "ok": 10,
        "failed": 7
      },
      "supersession": [
        {
          "bindingId": 65302,
          "status": "superseded",
          "clause": "AUTO-BAR-R-28-P-012@1",
          "evidenceKind": "test",
          "retracted": [
            {
              "bindingId": 65278,
              "workItemId": "WI-6554700010008887",
              "evidenceRef": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts"
            }
          ],
          "kept": []
        },
        {
          "bindingId": 65303,
          "status": "superseded",
          "clause": "AUTO-BAR-R-28-P-004@1",
          "evidenceKind": "test",
          "retracted": [
            {
              "bindingId": 65277,
              "workItemId": "WI-6554700010008887",
              "evidenceRef": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts"
            }
          ],
          "kept": []
        },
        {
          "bindingId": 65304,
          "status": "superseded",
          "clause": "AUTO-BAR-R-32-P-008@1",
          "evidenceKind": "test",
          "retracted": [],
          "kept": [
            {
              "bindingId": 65279,
              "workItemId": "WI-6554700010008887",
              "evidenceRef": "packages/operator-core/lib/scheduler/fleet-scope-admission.test.ts",
              "reason": "different-subject"
            }
          ]
        },
        {
          "bindingId": 65305,
          "status": "superseded",
          "clause": "AUTO-BAR-R-32-P-008@1",
          "evidenceKind": "test",
          "retracted": [],
          "kept": [
            {
              "bindingId": 65279,
              "workItemId": "WI-6554700010008887",
              "evidenceRef": "packages/operator-core/lib/scheduler/fleet-scope-admission.test.ts",
              "reason": "different-subject"
            }
          ]
        },
        {
          "bindingId": 65306,
          "status": "superseded",
          "clause": "AUTO-BAR-R-34-P-008@1",
          "evidenceKind": "test",
          "retracted": [],
          "kept": [
            {
              "bindingId": 65281,
              "workItemId": "WI-6554700010008887",
              "evidenceRef": "packages/operator-core/lib/scheduler/fleet-scope-admission.test.ts",
              "reason": "different-subject"
            }
          ]
        },
        {
          "bindingId": 65307,
          "status": "superseded",
          "clause": "AUTO-BAR-R-33-P-008@1",
          "evidenceKind": "test",
          "retracted": [],
          "kept": [
            {
              "bindingId": 65280,
              "workItemId": "WI-6554700010008887",
              "evidenceRef": "packages/operator-core/lib/scheduler/fleet-scope-admission.test.ts",
              "reason": "different-subject"
            }
          ]
        },
        {
          "bindingId": 65308,
          "status": "superseded",
          "clause": "AUTO-BAR-R-32-P-008@1",
          "evidenceKind": "test",
          "retracted": [],
          "kept": [
            {
              "bindingId": 65279,
              "workItemId": "WI-6554700010008887",
              "evidenceRef": "packages/operator-core/lib/scheduler/fleet-scope-admission.test.ts",
              "reason": "different-subject"
            }
          ]
        },
        {
          "bindingId": 65309,
          "status": "superseded",
          "clause": "AUTO-BAR-R-32-P-008@1",
          "evidenceKind": "test",
          "retracted": [],
          "kept": [
            {
              "bindingId": 65279,
              "workItemId": "WI-6554700010008887",
              "evidenceRef": "packages/operator-core/lib/scheduler/fleet-scope-admission.test.ts",
              "reason": "different-subject"
            }
          ]
        },
        {
          "bindingId": 65310,
          "status": "superseded",
          "clause": "AUTO-BAR-R-34-P-008@1",
          "evidenceKind": "test",
          "retracted": [],
          "kept": [
            {
              "bindingId": 65281,
              "workItemId": "WI-6554700010008887",
              "evidenceRef": "packages/operator-core/lib/scheduler/fleet-scope-admission.test.ts",
              "reason": "different-subject"
            }
          ]
        },
        {
          "bindingId": 65311,
          "status": "superseded",
          "clause": "AUTO-BAR-R-33-P-008@1",
          "evidenceKind": "test",
          "retracted": [],
          "kept": [
            {
              "bindingId": 65280,
              "workItemId": "WI-6554700010008887",
              "evidenceRef": "packages/operator-core/lib/scheduler/fleet-scope-admission.test.ts",
              "reason": "different-subject"
            }
          ]
        }
      ]
    },
    "mutation-binding-result": {
      "ok": true,
      "results": [
        {
          "ok": true,
          "slug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
          "derivedFromTestRun": {
            "testRunId": 21338051,
            "evidenceKind": "mutation",
            "evidenceRef": "test-run 21338051 mutation-probe mutant fail packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts @7a0aea1229ad",
            "measurement": {
              "schemaVersion": 1,
              "kind": "repo-files",
              "sourcePaths": [
                "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
                "packages/operator-core/lib/scheduler/fleet-scope-admission.ts"
              ],
              "testPaths": [
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts"
              ],
              "fixturePaths": [
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts"
              ]
            },
            "harnessAttribution": "run"
          },
          "status": "created",
          "id": 65312,
          "workItemId": "WI-6554700010008887",
          "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
          "specId": "AUTO-BAR-R-32-P-008",
          "sourceValId": null,
          "specRevision": 1,
          "specFingerprint": "53994729feb67fccdbf6a2616898d415aa8e167ac1eb3cbbc0f100524e08cdd9",
          "bindingFingerprint": "e333a1ab226cba6c117874a6901fe6e8edd01b7e60e455feda5894aa9b6f3a91"
        },
        {
          "ok": true,
          "slug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
          "derivedFromTestRun": {
            "testRunId": 21338076,
            "evidenceKind": "mutation",
            "evidenceRef": "test-run 21338076 mutation-probe mutant fail packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts @7a0aea1229ad",
            "measurement": {
              "schemaVersion": 1,
              "kind": "repo-files",
              "sourcePaths": [
                "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
                "packages/operator-core/lib/scheduler/fleet-scope-admission.ts"
              ],
              "testPaths": [
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts"
              ],
              "fixturePaths": [
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts"
              ]
            },
            "harnessAttribution": "run"
          },
          "status": "created",
          "id": 65313,
          "workItemId": "WI-6554700010008887",
          "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
          "specId": "AUTO-BAR-R-32-P-008",
          "sourceValId": null,
          "specRevision": 1,
          "specFingerprint": "53994729feb67fccdbf6a2616898d415aa8e167ac1eb3cbbc0f100524e08cdd9",
          "bindingFingerprint": "6f7abcf6d1df06e9c1b4701bb1658662f0d7abbac82ad3410c5018a6a3c18e71"
        },
        {
          "ok": true,
          "slug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
          "derivedFromTestRun": {
            "testRunId": 21338077,
            "evidenceKind": "mutation",
            "evidenceRef": "test-run 21338077 mutation-probe mutant fail packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts @7a0aea1229ad",
            "measurement": {
              "schemaVersion": 1,
              "kind": "repo-files",
              "sourcePaths": [
                "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
                "packages/operator-core/lib/scheduler/fleet-scope-admission.ts"
              ],
              "testPaths": [
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts"
              ],
              "fixturePaths": [
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts"
              ]
            },
            "harnessAttribution": "run"
          },
          "status": "created",
          "id": 65314,
          "workItemId": "WI-6554700010008887",
          "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
          "specId": "AUTO-BAR-R-34-P-008",
          "sourceValId": null,
          "specRevision": 1,
          "specFingerprint": "c0b85504df60ba7f2ca47a4f3bd9249eeb9258d6e18d9f24474f052ab6fb987d",
          "bindingFingerprint": "32a28bdf8bb838779fb44efe24a4539fa7d706db3f21a6def0840dc3c411bdd7"
        },
        {
          "ok": true,
          "slug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
          "derivedFromTestRun": {
            "testRunId": 21338047,
            "evidenceKind": "mutation",
            "evidenceRef": "test-run 21338047 mutation-probe mutant fail packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts @7a0aea1229ad",
            "measurement": {
              "schemaVersion": 1,
              "kind": "repo-files",
              "sourcePaths": [
                "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
                "packages/operator-core/lib/scheduler/fleet-scope-admission.ts"
              ],
              "testPaths": [
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts"
              ],
              "fixturePaths": [
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts"
              ]
            },
            "harnessAttribution": "run"
          },
          "status": "created",
          "id": 65315,
          "workItemId": "WI-6554700010008887",
          "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
          "specId": "AUTO-BAR-R-33-P-008",
          "sourceValId": null,
          "specRevision": 1,
          "specFingerprint": "b14f5695f8fad63f9724bbd5ab3d125673e8c4b0f5b3b4a491eaaead6dd0c8de",
          "bindingFingerprint": "6fc28c046747b60b296a1c83ca52a5d8aa3fa508712394824fd1085af58e0bbb"
        }
      ],
      "counts": {
        "ok": 4,
        "failed": 0
      },
      "supersession": [
        {
          "bindingId": 65312,
          "status": "superseded",
          "clause": "AUTO-BAR-R-32-P-008@1",
          "evidenceKind": "mutation",
          "retracted": [],
          "kept": []
        },
        {
          "bindingId": 65313,
          "status": "superseded",
          "clause": "AUTO-BAR-R-32-P-008@1",
          "evidenceKind": "mutation",
          "retracted": [],
          "kept": []
        },
        {
          "bindingId": 65314,
          "status": "superseded",
          "clause": "AUTO-BAR-R-34-P-008@1",
          "evidenceKind": "mutation",
          "retracted": [],
          "kept": []
        },
        {
          "bindingId": 65315,
          "status": "superseded",
          "clause": "AUTO-BAR-R-33-P-008@1",
          "evidenceKind": "mutation",
          "retracted": [],
          "kept": []
        }
      ]
    },
    "bind-reconcile": {
      "ok": true,
      "slug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
      "harnessSlug": "papercusp",
      "bounded": {
        "limit": 100,
        "truncatedByLimit": false
      },
      "detail": "full",
      "evidence": [
        {
          "id": 65311,
          "workItemId": "WI-6554700010008887",
          "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
          "specId": "AUTO-BAR-R-33-P-008",
          "sourceValId": null,
          "specRevision": 1,
          "currentRevision": 1,
          "specFingerprint": "b14f5695f8fad63f9724bbd5ab3d125673e8c4b0f5b3b4a491eaaead6dd0c8de",
          "evidenceKind": "test",
          "evidenceRef": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
          "fingerprints": {
            "sourceFingerprint": "sha256-file-set-v1:d77ddcdc736921dc57b8f996b0317b6b1c7969941e1f6364683bed83fa188574",
            "testFingerprint": "sha256-file-set-v1:05508d3af5b26c5c746e22c51dd61454cfce5f57fb6c63a5f58a2e38288ea140",
            "fixtureFingerprint": "sha256-file-set-v1:26ee514eba2ce6a8dcd76ea42e5a30cffd1e8ccf98441f777d654bcb65800727",
            "rubricFingerprint": null,
            "environmentFingerprint": null
          },
          "coverageEvidenceRef": null,
          "testRunId": 21338017,
          "testRunExecution": {
            "status": "pass",
            "passed": 46,
            "failed": 0,
            "skipped": 0,
            "collectionFailed": false,
            "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
            "passedCaseTitles": [
              "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: independent",
              "S41 actual scheduler advice behavior instrument > executes the advertised files selector and refuses undocumented guesses",
              "S41 actual scheduler advice behavior instrument > still rejects awaiting an existing blocker before finishing independent work",
              "S41 actual scheduler advice behavior instrument > rejects stop-first advice even when a later bounded await succeeds"
            ],
            "testLayer": "unit",
            "passedCaseTitleCount": 46,
            "passedCaseTitlesOmitted": 42,
            "passedCaseTitlesRef": {
              "tool": "testing:runs",
              "args": {
                "testRunIds": [
                  21338017
                ],
                "cases": true
              }
            }
          },
          "testRunProvenance": {
            "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
            "framework": "vitest",
            "source": "local",
            "mutationPhase": null,
            "commitSha": "7a0aea1229adb3561b53c9a8cad47b9792711406",
            "worktreeDirty": false
          },
          "details": {
            "scope": "Completed hermetic S41v4 unit/original LLM scenario proof on committed 7a0aea1229adb3561b53c9a8cad47b9792711406. Synthetic inline world; no live loop delivery, external review pickup, R14 census, gate or shipment claim. Reused for AUTO-BAR-R-33-P-008 after exact working/HEAD/pinned equality of every source, test and fixture; original terminal item untouched.",
            "testRun": {
              "id": 21338017,
              "source": "local",
              "status": "pass",
              "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
              "commitSha": "7a0aea1229adb3561b53c9a8cad47b9792711406",
              "finishedAt": "2026-10-17T15:24:24.531Z",
              "asCommitted": {
                "commitSha": "7a0aea1229adb3561b53c9a8cad47b9792711406",
                "repoPrefix": "",
                "measuredAtCommit": true
              },
              "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-7a0aea1229-czV0uD",
              "mutationPhase": null,
              "worktreeDirty": false,
              "recordedFilePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
              "harnessAttribution": "run"
            },
            "adequacy": {
              "outcome": "passed",
              "skipped": false,
              "executed": true,
              "targeted": "auto-bar-r-33-p-008",
              "collected": true,
              "testCases": [
                "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: independent",
                "S41 actual scheduler advice behavior instrument > executes the advertised files selector and refuses undocumented guesses",
                "S41 actual scheduler advice behavior instrument > still rejects awaiting an existing blocker before finishing independent work",
                "S41 actual scheduler advice behavior instrument > rejects stop-first advice even when a later bounded await succeeds"
              ],
              "testLayer": "unit",
              "fixtureFree": false,
              "scenarioIds": [
                "s41-independent"
              ],
              "pathReachable": true,
              "fixtureCalibrated": true,
              "oracleIndependent": true
            },
            "proofRef": "artifact:papercusp/audits/parked-agent-resumption-2026-10-09/resume144-pinned-unit-model-mutation-proof-424d5.json",
            "calibration": {
              "negative": [
                "S41 actual scheduler advice behavior instrument > executes the advertised files selector and refuses undocumented guesses",
                "S41 actual scheduler advice behavior instrument > still rejects awaiting an existing blocker before finishing independent work",
                "S41 actual scheduler advice behavior instrument > rejects stop-first advice even when a later bounded await succeeds"
              ],
              "positive": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: independent",
              "testRunId": 21338017,
              "inlineFixturePaths": [
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts"
              ]
            },
            "evidencePlane": "tree",
            "originBinding": {
              "specId": "S41-INDEPENDENT-WORK",
              "planSlug": "adhoc-work-item-specs",
              "bindingId": 54254
            },
            "measurementPin": {
              "files": [
                {
                  "path": "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
                  "repo": ".",
                  "clean": true,
                  "sha256": "bb108bbdc66b207a44155c6e3dfb6b37d85a4e3f3bffe3fdecafc6bfacb0301e",
                  "headBlob": "1420766e3acf71d1e99610963df770b45faf1313",
                  "dimension": "source"
                },
                {
                  "path": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
                  "repo": ".",
                  "clean": true,
                  "sha256": "92637eba5902dc27e899157db5e50516edcbe8dd1ae56c1dcd5d4fec60bf428b",
                  "headBlob": "f94c3928273cbd12fcda99c00024aaf7469acf2c",
                  "dimension": "source"
                },
                {
                  "path": "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
                  "repo": ".",
                  "clean": true,
                  "sha256": "8b08b2336b5046b985edee0914b9bff88319b32aaffd1cf62bca8e75c7e11427",
                  "headBlob": "ed65fdaf7e6c7c9e300c6c3ba52769bca82084ef",
                  "dimension": "source"
                },
                {
                  "path": "packages/operator-core/lib/scheduler/fleet-scope-admission.ts",
                  "repo": ".",
                  "clean": true,
                  "sha256": "7e5653d51dfd705a3b9a766198a4460a8d5dafa8af6228d2873c2baab6a27de1",
                  "headBlob": "94aa161adecb2612055a239d3589d0fc9a69dbd5",
                  "dimension": "source"
                },
                {
                  "path": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
                  "repo": ".",
                  "clean": true,
                  "sha256": "ed6005447069830a4b130d6f8c2c99e00cadf892fb27b5bc93aa43f720928705",
                  "headBlob": "c99da02d96f11078266e737fc8a4acf922765e35",
                  "dimension": "test"
                },
                {
                  "path": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
                  "repo": ".",
                  "clean": true,
                  "sha256": "ed6005447069830a4b130d6f8c2c99e00cadf892fb27b5bc93aa43f720928705",
                  "headBlob": "c99da02d96f11078266e737fc8a4acf922765e35",
                  "dimension": "fixture"
                },
                {
                  "path": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
                  "repo": ".",
                  "clean": true,
                  "sha256": "92637eba5902dc27e899157db5e50516edcbe8dd1ae56c1dcd5d4fec60bf428b",
                  "headBlob": "f94c3928273cbd12fcda99c00024aaf7469acf2c",
                  "dimension": "fixture"
                }
              ],
              "repos": [
                {
                  "head": "d32eae0110551750ed8698297b5f8851e94fd4e0",
                  "repo": ".",
                  "gitlink": null
                }
              ],
              "schemaVersion": 1
            },
            "oracleRationale": "Expected properties are independently authored from S41-INDEPENDENT-WORK / P-008 / D-009: complete the known independent test action before awaiting the exact peer dependency. The oracle replays observed tool effects and ordering, and does not copy fleetScopedMiss advice or trust SUT narrative. The unit suite accepts a valid trace and rejects the corresponding invalid trace; copy-out mutation 21338047 causes these exact negative guard cases to fail after passing baseline and copy baseline.",
            "currentMeasurement": {
              "kind": "repo-files",
              "testPaths": [
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts"
              ],
              "sourcePaths": [
                "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
                "packages/operator-core/lib/scheduler/fleet-scope-admission.ts"
              ],
              "fixturePaths": [
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts"
              ],
              "schemaVersion": 1
            }
          },
          "observedAt": "2026-10-22T23:17:10.495Z",
          "bindingFingerprint": "e55273f238bb48c3e641ec7f31ea4cee09f78f8b8ff58965e5e8c23546726c6c",
          "createdBy": "su-424d5476-0b13-401a-a926-0aaa9f212391",
          "createdAt": "2026-10-22T23:17:10.082Z",
          "serverMeasurement": {
            "status": "unavailable",
            "reason": "Cannot read properties of undefined (reading 'Latest')"
          },
          "currentness": {
            "overall": "unknown",
            "dimensions": {
              "spec": "current",
              "source": "unknown",
              "test": "unknown",
              "fixture": "unknown",
              "rubric": "not-applicable",
              "environment": "not-applicable",
              "coverageEvidence": "not-applicable",
              "testRun": "current"
            },
            "staleReasons": [],
            "unknownReasons": [
              "source-current-fingerprint-not-supplied",
              "test-current-fingerprint-not-supplied",
              "fixture-current-fingerprint-not-supplied",
              "server-measurement-unavailable:Cannot read properties of undefined (reading 'Latest')"
            ],
            "comparisonSupplied": false,
            "provenance": "not-supplied"
          }
        },
        {
          "id": 65310,
          "workItemId": "WI-6554700010008887",
          "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
          "specId": "AUTO-BAR-R-34-P-008",
          "sourceValId": null,
          "specRevision": 1,
          "currentRevision": 1,
          "specFingerprint": "c0b85504df60ba7f2ca47a4f3bd9249eeb9258d6e18d9f24474f052ab6fb987d",
          "evidenceKind": "test",
          "evidenceRef": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
          "fingerprints": {
            "sourceFingerprint": "sha256-file-set-v1:d77ddcdc736921dc57b8f996b0317b6b1c7969941e1f6364683bed83fa188574",
            "testFingerprint": "sha256-file-set-v1:05508d3af5b26c5c746e22c51dd61454cfce5f57fb6c63a5f58a2e38288ea140",
            "fixtureFingerprint": "sha256-file-set-v1:26ee514eba2ce6a8dcd76ea42e5a30cffd1e8ccf98441f777d654bcb65800727",
            "rubricFingerprint": null,
            "environmentFingerprint": null
          },
          "coverageEvidenceRef": null,
          "testRunId": 21338017,
          "testRunExecution": {
            "status": "pass",
            "passed": 46,
            "failed": 0,
            "skipped": 0,
            "collectionFailed": false,
            "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
            "passedCaseTitles": [
              "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: blocked",
              "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":0,\"on_timeout\":\"wake\"}",
              "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":601,\"on_timeout\":\"wake\"}"
            ],
            "testLayer": "unit",
            "passedCaseTitleCount": 46,
            "passedCaseTitlesOmitted": 43,
            "passedCaseTitlesRef": {
              "tool": "testing:runs",
              "args": {
                "testRunIds": [
                  21338017
                ],
                "cases": true
              }
            }
          },
          "testRunProvenance": {
            "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
            "framework": "vitest",
            "source": "local",
            "mutationPhase": null,
            "commitSha": "7a0aea1229adb3561b53c9a8cad47b9792711406",
            "worktreeDirty": false
          },
          "details": {
            "scope": "Completed hermetic S41v4 unit/original LLM scenario proof on committed 7a0aea1229adb3561b53c9a8cad47b9792711406. Synthetic inline world; no live loop delivery, external review pickup, R14 census, gate or shipment claim. Reused for AUTO-BAR-R-34-P-008 after exact working/HEAD/pinned equality of every source, test and fixture; original terminal item untouched.",
            "testRun": {
              "id": 21338017,
              "source": "local",
              "status": "pass",
              "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
              "commitSha": "7a0aea1229adb3561b53c9a8cad47b9792711406",
              "finishedAt": "2026-10-17T15:24:24.531Z",
              "asCommitted": {
                "commitSha": "7a0aea1229adb3561b53c9a8cad47b9792711406",
                "repoPrefix": "",
                "measuredAtCommit": true
              },
              "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-7a0aea1229-czV0uD",
              "mutationPhase": null,
              "worktreeDirty": false,
              "recordedFilePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
              "harnessAttribution": "run"
            },
            "adequacy": {
              "outcome": "passed",
              "skipped": false,
              "executed": true,
              "targeted": "auto-bar-r-34-p-008",
              "collected": true,
              "testCases": [
                "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: blocked",
                "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":0,\"on_timeout\":\"wake\"}",
                "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":601,\"on_timeout\":\"wake\"}"
              ],
              "testLayer": "unit",
              "fixtureFree": false,
              "scenarioIds": [
                "s41-blocked"
              ],
              "pathReachable": true,
              "fixtureCalibrated": true,
              "oracleIndependent": true
            },
            "proofRef": "artifact:papercusp/audits/parked-agent-resumption-2026-10-09/resume144-pinned-unit-model-mutation-proof-424d5.json",
            "calibration": {
              "negative": [
                "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":0,\"on_timeout\":\"wake\"}",
                "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":601,\"on_timeout\":\"wake\"}"
              ],
              "positive": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: blocked",
              "testRunId": 21338017,
              "inlineFixturePaths": [
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts"
              ]
            },
            "evidencePlane": "tree",
            "originBinding": {
              "specId": "S41-BOUNDED-DEPENDENCY",
              "planSlug": "adhoc-work-item-specs",
              "bindingId": 54256
            },
            "measurementPin": {
              "files": [
                {
                  "path": "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
                  "repo": ".",
                  "clean": true,
                  "sha256": "bb108bbdc66b207a44155c6e3dfb6b37d85a4e3f3bffe3fdecafc6bfacb0301e",
                  "headBlob": "1420766e3acf71d1e99610963df770b45faf1313",
                  "dimension": "source"
                },
                {
                  "path": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
                  "repo": ".",
                  "clean": true,
                  "sha256": "92637eba5902dc27e899157db5e50516edcbe8dd1ae56c1dcd5d4fec60bf428b",
                  "headBlob": "f94c3928273cbd12fcda99c00024aaf7469acf2c",
                  "dimension": "source"
                },
                {
                  "path": "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
                  "repo": ".",
                  "clean": true,
                  "sha256": "8b08b2336b5046b985edee0914b9bff88319b32aaffd1cf62bca8e75c7e11427",
                  "headBlob": "ed65fdaf7e6c7c9e300c6c3ba52769bca82084ef",
                  "dimension": "source"
                },
                {
                  "path": "packages/operator-core/lib/scheduler/fleet-scope-admission.ts",
                  "repo": ".",
                  "clean": true,
                  "sha256": "7e5653d51dfd705a3b9a766198a4460a8d5dafa8af6228d2873c2baab6a27de1",
                  "headBlob": "94aa161adecb2612055a239d3589d0fc9a69dbd5",
                  "dimension": "source"
                },
                {
                  "path": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
                  "repo": ".",
                  "clean": true,
                  "sha256": "ed6005447069830a4b130d6f8c2c99e00cadf892fb27b5bc93aa43f720928705",
                  "headBlob": "c99da02d96f11078266e737fc8a4acf922765e35",
                  "dimension": "test"
                },
                {
                  "path": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
                  "repo": ".",
                  "clean": true,
                  "sha256": "ed6005447069830a4b130d6f8c2c99e00cadf892fb27b5bc93aa43f720928705",
                  "headBlob": "c99da02d96f11078266e737fc8a4acf922765e35",
                  "dimension": "fixture"
                },
                {
                  "path": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
                  "repo": ".",
                  "clean": true,
                  "sha256": "92637eba5902dc27e899157db5e50516edcbe8dd1ae56c1dcd5d4fec60bf428b",
                  "headBlob": "f94c3928273cbd12fcda99c00024aaf7469acf2c",
                  "dimension": "fixture"
                }
              ],
              "repos": [
                {
                  "head": "d32eae0110551750ed8698297b5f8851e94fd4e0",
                  "repo": ".",
                  "gitlink": null
                }
              ],
              "schemaVersion": 1
            },
            "oracleRationale": "Expected properties are independently authored from S41-BOUNDED-DEPENDENCY / P-008 / D-009: retain the claim and establish the exact positive bounded dependency wake before any loop stop. The oracle replays observed tool effects and ordering, and does not copy fleetScopedMiss advice or trust SUT narrative. The unit suite accepts a valid trace and rejects the corresponding invalid trace; copy-out mutation 21338077 causes these exact negative guard cases to fail after passing baseline and copy baseline.",
            "currentMeasurement": {
              "kind": "repo-files",
              "testPaths": [
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts"
              ],
              "sourcePaths": [
                "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
                "packages/operator-core/lib/scheduler/fleet-scope-admission.ts"
              ],
              "fixturePaths": [
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts"
              ],
              "schemaVersion": 1
            }
          },
          "observedAt": "2026-10-22T23:17:08.764Z",
          "bindingFingerprint": "444e44b92723e434d0dd95136fa4629e27729b7281c9891594ad0f8953f41bc6",
          "createdBy": "su-424d5476-0b13-401a-a926-0aaa9f212391",
          "createdAt": "2026-10-22T23:17:08.463Z",
          "serverMeasurement": {
            "status": "unavailable",
            "reason": "Cannot read properties of undefined (reading 'Latest')"
          },
          "currentness": {
            "overall": "unknown",
            "dimensions": {
              "spec": "current",
              "source": "unknown",
              "test": "unknown",
              "fixture": "unknown",
              "rubric": "not-applicable",
              "environment": "not-applicable",
              "coverageEvidence": "not-applicable",
              "testRun": "current"
            },
            "staleReasons": [],
            "unknownReasons": [
              "source-current-fingerprint-not-supplied",
              "test-current-fingerprint-not-supplied",
              "fixture-current-fingerprint-not-supplied",
              "server-measurement-unavailable:Cannot read properties of undefined (reading 'Latest')"
            ],
            "comparisonSupplied": false,
            "provenance": "not-supplied"
          }
        },
        {
          "id": 65309,
          "workItemId": "WI-6554700010008887",
          "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
          "specId": "AUTO-BAR-R-32-P-008",
          "sourceValId": null,
          "specRevision": 1,
          "currentRevision": 1,
          "specFingerprint": "53994729feb67fccdbf6a2616898d415aa8e167ac1eb3cbbc0f100524e08cdd9",
          "evidenceKind": "test",
          "evidenceRef": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
          "fingerprints": {
            "sourceFingerprint": "sha256-file-set-v1:d77ddcdc736921dc57b8f996b0317b6b1c7969941e1f6364683bed83fa188574",
            "testFingerprint": "sha256-file-set-v1:05508d3af5b26c5c746e22c51dd61454cfce5f57fb6c63a5f58a2e38288ea140",
            "fixtureFingerprint": "sha256-file-set-v1:26ee514eba2ce6a8dcd76ea42e5a30cffd1e8ccf98441f777d654bcb65800727",
            "rubricFingerprint": null,
            "environmentFingerprint": null
          },
          "coverageEvidenceRef": null,
          "testRunId": 21338017,
          "testRunExecution": {
            "status": "pass",
            "passed": 46,
            "failed": 0,
            "skipped": 0,
            "collectionFailed": false,
            "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
            "passedCaseTitles": [
              "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: no-event",
              "S41 actual scheduler advice behavior instrument > rejects a backlog watch as retained-work wake, release of held work, invented blockers and duplicate loops",
              "S41 actual scheduler advice behavior instrument > rejects the observed fabricated peer-review ref without creating a dependency or stopping its loop"
            ],
            "testLayer": "unit",
            "passedCaseTitleCount": 46,
            "passedCaseTitlesOmitted": 43,
            "passedCaseTitlesRef": {
              "tool": "testing:runs",
              "args": {
                "testRunIds": [
                  21338017
                ],
                "cases": true
              }
            }
          },
          "testRunProvenance": {
            "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
            "framework": "vitest",
            "source": "local",
            "mutationPhase": null,
            "commitSha": "7a0aea1229adb3561b53c9a8cad47b9792711406",
            "worktreeDirty": false
          },
          "details": {
            "scope": "Completed hermetic S41v4 unit/original LLM scenario proof on committed 7a0aea1229adb3561b53c9a8cad47b9792711406. Synthetic inline world; no live loop delivery, external review pickup, R14 census, gate or shipment claim. Reused for AUTO-BAR-R-32-P-008 after exact working/HEAD/pinned equality of every source, test and fixture; original terminal item untouched.",
            "testRun": {
              "id": 21338017,
              "source": "local",
              "status": "pass",
              "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
              "commitSha": "7a0aea1229adb3561b53c9a8cad47b9792711406",
              "finishedAt": "2026-10-17T15:24:24.531Z",
              "asCommitted": {
                "commitSha": "7a0aea1229adb3561b53c9a8cad47b9792711406",
                "repoPrefix": "",
                "measuredAtCommit": true
              },
              "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-7a0aea1229-czV0uD",
              "mutationPhase": null,
              "worktreeDirty": false,
              "recordedFilePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
              "harnessAttribution": "run"
            },
            "adequacy": {
              "outcome": "passed",
              "skipped": false,
              "executed": true,
              "targeted": "auto-bar-r-32-p-008",
              "collected": true,
              "testCases": [
                "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: no-event",
                "S41 actual scheduler advice behavior instrument > rejects a backlog watch as retained-work wake, release of held work, invented blockers and duplicate loops",
                "S41 actual scheduler advice behavior instrument > rejects the observed fabricated peer-review ref without creating a dependency or stopping its loop"
              ],
              "testLayer": "unit",
              "fixtureFree": false,
              "scenarioIds": [
                "s41-no-event"
              ],
              "pathReachable": true,
              "fixtureCalibrated": true,
              "oracleIndependent": true
            },
            "proofRef": "artifact:papercusp/audits/parked-agent-resumption-2026-10-09/resume144-pinned-unit-model-mutation-proof-424d5.json",
            "calibration": {
              "negative": [
                "S41 actual scheduler advice behavior instrument > rejects a backlog watch as retained-work wake, release of held work, invented blockers and duplicate loops",
                "S41 actual scheduler advice behavior instrument > rejects the observed fabricated peer-review ref without creating a dependency or stopping its loop"
              ],
              "positive": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: no-event",
              "testRunId": 21338017,
              "inlineFixturePaths": [
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts"
              ]
            },
            "evidencePlane": "tree",
            "originBinding": {
              "specId": "S41-MISSING-EVENT",
              "planSlug": "adhoc-work-item-specs",
              "bindingId": 54258
            },
            "measurementPin": {
              "files": [
                {
                  "path": "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
                  "repo": ".",
                  "clean": true,
                  "sha256": "bb108bbdc66b207a44155c6e3dfb6b37d85a4e3f3bffe3fdecafc6bfacb0301e",
                  "headBlob": "1420766e3acf71d1e99610963df770b45faf1313",
                  "dimension": "source"
                },
                {
                  "path": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
                  "repo": ".",
                  "clean": true,
                  "sha256": "92637eba5902dc27e899157db5e50516edcbe8dd1ae56c1dcd5d4fec60bf428b",
                  "headBlob": "f94c3928273cbd12fcda99c00024aaf7469acf2c",
                  "dimension": "source"
                },
                {
                  "path": "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
                  "repo": ".",
                  "clean": true,
                  "sha256": "8b08b2336b5046b985edee0914b9bff88319b32aaffd1cf62bca8e75c7e11427",
                  "headBlob": "ed65fdaf7e6c7c9e300c6c3ba52769bca82084ef",
                  "dimension": "source"
                },
                {
                  "path": "packages/operator-core/lib/scheduler/fleet-scope-admission.ts",
                  "repo": ".",
                  "clean": true,
                  "sha256": "7e5653d51dfd705a3b9a766198a4460a8d5dafa8af6228d2873c2baab6a27de1",
                  "headBlob": "94aa161adecb2612055a239d3589d0fc9a69dbd5",
                  "dimension": "source"
                },
                {
                  "path": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
                  "repo": ".",
                  "clean": true,
                  "sha256": "ed6005447069830a4b130d6f8c2c99e00cadf892fb27b5bc93aa43f720928705",
                  "headBlob": "c99da02d96f11078266e737fc8a4acf922765e35",
                  "dimension": "test"
                },
                {
                  "path": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
                  "repo": ".",
                  "clean": true,
                  "sha256": "ed6005447069830a4b130d6f8c2c99e00cadf892fb27b5bc93aa43f720928705",
                  "headBlob": "c99da02d96f11078266e737fc8a4acf922765e35",
                  "dimension": "fixture"
                },
                {
                  "path": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
                  "repo": ".",
                  "clean": true,
                  "sha256": "92637eba5902dc27e899157db5e50516edcbe8dd1ae56c1dcd5d4fec60bf428b",
                  "headBlob": "f94c3928273cbd12fcda99c00024aaf7469acf2c",
                  "dimension": "fixture"
                }
              ],
              "repos": [
                {
                  "head": "d32eae0110551750ed8698297b5f8851e94fd4e0",
                  "repo": ".",
                  "gitlink": null
                }
              ],
              "schemaVersion": 1
            },
            "oracleRationale": "Expected properties are independently authored from S41-MISSING-EVENT / P-008 / D-009: preserve the existing loop and checkpoint without inventing a dependency. The oracle replays observed tool effects and ordering, and does not copy fleetScopedMiss advice or trust SUT narrative. The unit suite accepts a valid trace and rejects the corresponding invalid trace; copy-out mutation 21338076 causes these exact negative guard cases to fail after passing baseline and copy baseline.",
            "currentMeasurement": {
              "kind": "repo-files",
              "testPaths": [
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts"
              ],
              "sourcePaths": [
                "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
                "packages/operator-core/lib/scheduler/fleet-scope-admission.ts"
              ],
              "fixturePaths": [
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts"
              ],
              "schemaVersion": 1
            }
          },
          "observedAt": "2026-10-22T23:17:07.241Z",
          "bindingFingerprint": "6511ab0e23d6115dbfe5a59d7712f734e9fb8e111444138dc96feafc1715257f",
          "createdBy": "su-424d5476-0b13-401a-a926-0aaa9f212391",
          "createdAt": "2026-10-22T23:17:07.154Z",
          "serverMeasurement": {
            "status": "unavailable",
            "reason": "Cannot read properties of undefined (reading 'Latest')"
          },
          "currentness": {
            "overall": "unknown",
            "dimensions": {
              "spec": "current",
              "source": "unknown",
              "test": "unknown",
              "fixture": "unknown",
              "rubric": "not-applicable",
              "environment": "not-applicable",
              "coverageEvidence": "not-applicable",
              "testRun": "current"
            },
            "staleReasons": [],
            "unknownReasons": [
              "source-current-fingerprint-not-supplied",
              "test-current-fingerprint-not-supplied",
              "fixture-current-fingerprint-not-supplied",
              "server-measurement-unavailable:Cannot read properties of undefined (reading 'Latest')"
            ],
            "comparisonSupplied": false,
            "provenance": "not-supplied"
          }
        },
        {
          "id": 65308,
          "workItemId": "WI-6554700010008887",
          "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
          "specId": "AUTO-BAR-R-32-P-008",
          "sourceValId": null,
          "specRevision": 1,
          "currentRevision": 1,
          "specFingerprint": "53994729feb67fccdbf6a2616898d415aa8e167ac1eb3cbbc0f100524e08cdd9",
          "evidenceKind": "test",
          "evidenceRef": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
          "fingerprints": {
            "sourceFingerprint": "sha256-file-set-v1:d77ddcdc736921dc57b8f996b0317b6b1c7969941e1f6364683bed83fa188574",
            "testFingerprint": "sha256-file-set-v1:05508d3af5b26c5c746e22c51dd61454cfce5f57fb6c63a5f58a2e38288ea140",
            "fixtureFingerprint": "sha256-file-set-v1:26ee514eba2ce6a8dcd76ea42e5a30cffd1e8ccf98441f777d654bcb65800727",
            "rubricFingerprint": null,
            "environmentFingerprint": null
          },
          "coverageEvidenceRef": null,
          "testRunId": 21338017,
          "testRunExecution": {
            "status": "pass",
            "passed": 46,
            "failed": 0,
            "skipped": 0,
            "collectionFailed": false,
            "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
            "passedCaseTitles": [
              "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: finished",
              "S41 actual scheduler advice behavior instrument > calibration: finished work stops, while missing-event work checkpoints and keeps its loop"
            ],
            "testLayer": "unit",
            "passedCaseTitleCount": 46,
            "passedCaseTitlesOmitted": 44,
            "passedCaseTitlesRef": {
              "tool": "testing:runs",
              "args": {
                "testRunIds": [
                  21338017
                ],
                "cases": true
              }
            }
          },
          "testRunProvenance": {
            "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
            "framework": "vitest",
            "source": "local",
            "mutationPhase": null,
            "commitSha": "7a0aea1229adb3561b53c9a8cad47b9792711406",
            "worktreeDirty": false
          },
          "details": {
            "scope": "Completed hermetic S41v4 unit/original LLM scenario proof on committed 7a0aea1229adb3561b53c9a8cad47b9792711406. Synthetic inline world; no live loop delivery, external review pickup, R14 census, gate or shipment claim. Reused for AUTO-BAR-R-32-P-008 after exact working/HEAD/pinned equality of every source, test and fixture; original terminal item untouched.",
            "testRun": {
              "id": 21338017,
              "source": "local",
              "status": "pass",
              "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
              "commitSha": "7a0aea1229adb3561b53c9a8cad47b9792711406",
              "finishedAt": "2026-10-17T15:24:24.531Z",
              "asCommitted": {
                "commitSha": "7a0aea1229adb3561b53c9a8cad47b9792711406",
                "repoPrefix": "",
                "measuredAtCommit": true
              },
              "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-7a0aea1229-czV0uD",
              "mutationPhase": null,
              "worktreeDirty": false,
              "recordedFilePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
              "harnessAttribution": "run"
            },
            "adequacy": {
              "outcome": "passed",
              "skipped": false,
              "executed": true,
              "targeted": "auto-bar-r-32-p-008",
              "collected": true,
              "testCases": [
                "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: finished",
                "S41 actual scheduler advice behavior instrument > calibration: finished work stops, while missing-event work checkpoints and keeps its loop"
              ],
              "testLayer": "unit",
              "fixtureFree": false,
              "scenarioIds": [
                "s41-finished"
              ],
              "pathReachable": true,
              "fixtureCalibrated": true,
              "oracleIndependent": true
            },
            "proofRef": "artifact:papercusp/audits/parked-agent-resumption-2026-10-09/resume144-pinned-unit-model-mutation-proof-424d5.json",
            "calibration": {
              "negative": [
                "S41 actual scheduler advice behavior instrument > calibration: finished work stops, while missing-event work checkpoints and keeps its loop"
              ],
              "positive": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: finished",
              "testRunId": 21338017,
              "inlineFixturePaths": [
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts"
              ]
            },
            "evidencePlane": "tree",
            "originBinding": {
              "specId": "S41-FINISHED-STOP",
              "planSlug": "adhoc-work-item-specs",
              "bindingId": 54260
            },
            "measurementPin": {
              "files": [
                {
                  "path": "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
                  "repo": ".",
                  "clean": true,
                  "sha256": "bb108bbdc66b207a44155c6e3dfb6b37d85a4e3f3bffe3fdecafc6bfacb0301e",
                  "headBlob": "1420766e3acf71d1e99610963df770b45faf1313",
                  "dimension": "source"
                },
                {
                  "path": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
                  "repo": ".",
                  "clean": true,
                  "sha256": "92637eba5902dc27e899157db5e50516edcbe8dd1ae56c1dcd5d4fec60bf428b",
                  "headBlob": "f94c3928273cbd12fcda99c00024aaf7469acf2c",
                  "dimension": "source"
                },
                {
                  "path": "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
                  "repo": ".",
                  "clean": true,
                  "sha256": "8b08b2336b5046b985edee0914b9bff88319b32aaffd1cf62bca8e75c7e11427",
                  "headBlob": "ed65fdaf7e6c7c9e300c6c3ba52769bca82084ef",
                  "dimension": "source"
                },
                {
                  "path": "packages/operator-core/lib/scheduler/fleet-scope-admission.ts",
                  "repo": ".",
                  "clean": true,
                  "sha256": "7e5653d51dfd705a3b9a766198a4460a8d5dafa8af6228d2873c2baab6a27de1",
                  "headBlob": "94aa161adecb2612055a239d3589d0fc9a69dbd5",
                  "dimension": "source"
                },
                {
                  "path": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
                  "repo": ".",
                  "clean": true,
                  "sha256": "ed6005447069830a4b130d6f8c2c99e00cadf892fb27b5bc93aa43f720928705",
                  "headBlob": "c99da02d96f11078266e737fc8a4acf922765e35",
                  "dimension": "test"
                },
                {
                  "path": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
                  "repo": ".",
                  "clean": true,
                  "sha256": "ed6005447069830a4b130d6f8c2c99e00cadf892fb27b5bc93aa43f720928705",
                  "headBlob": "c99da02d96f11078266e737fc8a4acf922765e35",
                  "dimension": "fixture"
                },
                {
                  "path": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
                  "repo": ".",
                  "clean": true,
                  "sha256": "92637eba5902dc27e899157db5e50516edcbe8dd1ae56c1dcd5d4fec60bf428b",
                  "headBlob": "f94c3928273cbd12fcda99c00024aaf7469acf2c",
                  "dimension": "fixture"
                }
              ],
              "repos": [
                {
                  "head": "d32eae0110551750ed8698297b5f8851e94fd4e0",
                  "repo": ".",
                  "gitlink": null
                }
              ],
              "schemaVersion": 1
            },
            "oracleRationale": "Expected properties are independently authored from S41-FINISHED-STOP / P-008 / D-009: stop the existing loop only after all requested work is complete and no retained obligation remains. The oracle replays observed tool effects and ordering, and does not copy fleetScopedMiss advice or trust SUT narrative. The unit suite accepts a valid trace and rejects the corresponding invalid trace; copy-out mutation 21338051 causes these exact negative guard cases to fail after passing baseline and copy baseline.",
            "currentMeasurement": {
              "kind": "repo-files",
              "testPaths": [
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts"
              ],
              "sourcePaths": [
                "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
                "packages/operator-core/lib/scheduler/fleet-scope-admission.ts"
              ],
              "fixturePaths": [
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts"
              ],
              "schemaVersion": 1
            }
          },
          "observedAt": "2026-10-22T23:17:06.309Z",
          "bindingFingerprint": "27f412c168433fc84e1d48beb153b7ab12a2b28bee4c6b5410b356e2cd881a2b",
          "createdBy": "su-424d5476-0b13-401a-a926-0aaa9f212391",
          "createdAt": "2026-10-22T23:17:06.048Z",
          "serverMeasurement": {
            "status": "unavailable",
            "reason": "Cannot read properties of undefined (reading 'Latest')"
          },
          "currentness": {
            "overall": "unknown",
            "dimensions": {
              "spec": "current",
              "source": "unknown",
              "test": "unknown",
              "fixture": "unknown",
              "rubric": "not-applicable",
              "environment": "not-applicable",
              "coverageEvidence": "not-applicable",
              "testRun": "current"
            },
            "staleReasons": [],
            "unknownReasons": [
              "source-current-fingerprint-not-supplied",
              "test-current-fingerprint-not-supplied",
              "fixture-current-fingerprint-not-supplied",
              "server-measurement-unavailable:Cannot read properties of undefined (reading 'Latest')"
            ],
            "comparisonSupplied": false,
            "provenance": "not-supplied"
          }
        },
        {
          "id": 65307,
          "workItemId": "WI-6554700010008887",
          "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
          "specId": "AUTO-BAR-R-33-P-008",
          "sourceValId": null,
          "specRevision": 1,
          "currentRevision": 1,
          "specFingerprint": "b14f5695f8fad63f9724bbd5ab3d125673e8c4b0f5b3b4a491eaaead6dd0c8de",
          "evidenceKind": "test",
          "evidenceRef": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
          "fingerprints": {
            "sourceFingerprint": "sha256-file-set-v1:d77ddcdc736921dc57b8f996b0317b6b1c7969941e1f6364683bed83fa188574",
            "testFingerprint": "sha256-file-set-v1:f1739938687b792bbcb319999adbc0dc7e538558aafab8404e15580d7cb716b5",
            "fixtureFingerprint": "sha256-file-set-v1:26ee514eba2ce6a8dcd76ea42e5a30cffd1e8ccf98441f777d654bcb65800727",
            "rubricFingerprint": null,
            "environmentFingerprint": "c135806af46e0ac2b566b96e9d240fa9604101439da0a1a233e433b0f8739aa0"
          },
          "coverageEvidenceRef": null,
          "testRunId": 21338040,
          "testRunExecution": {
            "status": "pass",
            "passed": 3,
            "failed": 0,
            "skipped": 0,
            "collectionFailed": false,
            "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
            "scenarioId": "su-S41-scheduler-independent",
            "passedCaseTitlesIncomplete": true,
            "testLayer": "llm"
          },
          "testRunProvenance": {
            "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
            "framework": "llm-test",
            "source": "local",
            "mutationPhase": null,
            "commitSha": "7a0aea1229adb3561b53c9a8cad47b9792711406",
            "worktreeDirty": false
          },
          "details": {
            "scope": "Completed hermetic S41v4 unit/original LLM scenario proof on committed 7a0aea1229adb3561b53c9a8cad47b9792711406. Synthetic inline world; no live loop delivery, external review pickup, R14 census, gate or shipment claim. Reused for AUTO-BAR-R-33-P-008 after exact working/HEAD/pinned equality of every source, test and fixture; original terminal item untouched.",
            "testRun": {
              "id": 21338040,
              "source": "local",
              "status": "pass",
              "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
              "commitSha": "7a0aea1229adb3561b53c9a8cad47b9792711406",
              "finishedAt": "2026-10-17T15:27:06.135Z",
              "asCommitted": {
                "commitSha": "7a0aea1229adb3561b53c9a8cad47b9792711406",
                "repoPrefix": "",
                "measuredAtCommit": true
              },
              "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-7a0aea1229-czV0uD",
              "mutationPhase": null,
              "worktreeDirty": false,
              "recordedFilePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
              "harnessAttribution": "run"
            },
            "adequacy": {
              "outcome": "passed",
              "skipped": false,
              "executed": true,
              "targeted": "auto-bar-r-33-p-008",
              "collected": true,
              "testCases": [
                "su-S41-scheduler-independent"
              ],
              "testLayer": "llm",
              "fixtureFree": false,
              "scenarioIds": [
                "s41-independent"
              ],
              "pathReachable": true,
              "fixtureCalibrated": true,
              "oracleIndependent": true
            },
            "proofRef": "artifact:papercusp/audits/parked-agent-resumption-2026-10-09/resume144-pinned-unit-model-mutation-proof-424d5.json",
            "calibration": {
              "negative": [
                "S41 actual scheduler advice behavior instrument > executes the advertised files selector and refuses undocumented guesses",
                "S41 actual scheduler advice behavior instrument > still rejects awaiting an existing blocker before finishing independent work",
                "S41 actual scheduler advice behavior instrument > rejects stop-first advice even when a later bounded await succeeds"
              ],
              "positive": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: independent",
              "testRunId": 21338017,
              "inlineFixturePaths": [
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts"
              ]
            },
            "evidencePlane": "live",
            "originBinding": {
              "specId": "S41-INDEPENDENT-WORK",
              "planSlug": "adhoc-work-item-specs",
              "bindingId": 54263
            },
            "measurementPin": {
              "files": [
                {
                  "path": "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
                  "repo": ".",
                  "clean": true,
                  "sha256": "bb108bbdc66b207a44155c6e3dfb6b37d85a4e3f3bffe3fdecafc6bfacb0301e",
                  "headBlob": "1420766e3acf71d1e99610963df770b45faf1313",
                  "dimension": "source"
                },
                {
                  "path": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
                  "repo": ".",
                  "clean": true,
                  "sha256": "92637eba5902dc27e899157db5e50516edcbe8dd1ae56c1dcd5d4fec60bf428b",
                  "headBlob": "f94c3928273cbd12fcda99c00024aaf7469acf2c",
                  "dimension": "source"
                },
                {
                  "path": "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
                  "repo": ".",
                  "clean": true,
                  "sha256": "8b08b2336b5046b985edee0914b9bff88319b32aaffd1cf62bca8e75c7e11427",
                  "headBlob": "ed65fdaf7e6c7c9e300c6c3ba52769bca82084ef",
                  "dimension": "source"
                },
                {
                  "path": "packages/operator-core/lib/scheduler/fleet-scope-admission.ts",
                  "repo": ".",
                  "clean": true,
                  "sha256": "7e5653d51dfd705a3b9a766198a4460a8d5dafa8af6228d2873c2baab6a27de1",
                  "headBlob": "94aa161adecb2612055a239d3589d0fc9a69dbd5",
                  "dimension": "source"
                },
                {
                  "path": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
                  "repo": ".",
                  "clean": true,
                  "sha256": "92637eba5902dc27e899157db5e50516edcbe8dd1ae56c1dcd5d4fec60bf428b",
                  "headBlob": "f94c3928273cbd12fcda99c00024aaf7469acf2c",
                  "dimension": "test"
                },
                {
                  "path": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
                  "repo": ".",
                  "clean": true,
                  "sha256": "ed6005447069830a4b130d6f8c2c99e00cadf892fb27b5bc93aa43f720928705",
                  "headBlob": "c99da02d96f11078266e737fc8a4acf922765e35",
                  "dimension": "fixture"
                },
                {
                  "path": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
                  "repo": ".",
                  "clean": true,
                  "sha256": "92637eba5902dc27e899157db5e50516edcbe8dd1ae56c1dcd5d4fec60bf428b",
                  "headBlob": "f94c3928273cbd12fcda99c00024aaf7469acf2c",
                  "dimension": "fixture"
                }
              ],
              "repos": [
                {
                  "head": "d32eae0110551750ed8698297b5f8851e94fd4e0",
                  "repo": ".",
                  "gitlink": null
                }
              ],
              "schemaVersion": 1
            },
            "oracleRationale": "Expected properties are independently authored from S41-INDEPENDENT-WORK / P-008 / D-009: complete the known independent test action before awaiting the exact peer dependency. The oracle replays observed tool effects and ordering, and does not copy fleetScopedMiss advice or trust SUT narrative. The unit suite accepts a valid trace and rejects the corresponding invalid trace; copy-out mutation 21338047 causes these exact negative guard cases to fail after passing baseline and copy baseline.",
            "currentMeasurement": {
              "kind": "repo-files",
              "testPaths": [
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts"
              ],
              "sourcePaths": [
                "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
                "packages/operator-core/lib/scheduler/fleet-scope-admission.ts"
              ],
              "fixturePaths": [
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts"
              ],
              "runtimeUnits": [
                "llm-test-in-process-959660"
              ],
              "schemaVersion": 1,
              "completedRuntime": {
                "kind": "llm-in-process"
              }
            },
            "runtimePlaneMeaning": "live labels the originally observed hermetic in-process witness certified through completedRuntime; no present PID, serving deployment or live-loop delivery is asserted."
          },
          "observedAt": "2026-10-22T23:17:05.315Z",
          "bindingFingerprint": "74dfa45516752df32a7fc8d70cad4a94b721585ae03236db0d5b854372c164dd",
          "createdBy": "su-424d5476-0b13-401a-a926-0aaa9f212391",
          "createdAt": "2026-10-22T23:17:04.704Z",
          "serverMeasurement": {
            "status": "unavailable",
            "reason": "Cannot read properties of undefined (reading 'Latest')"
          },
          "currentness": {
            "overall": "unknown",
            "dimensions": {
              "spec": "current",
              "source": "unknown",
              "test": "unknown",
              "fixture": "unknown",
              "rubric": "not-applicable",
              "environment": "unknown",
              "coverageEvidence": "not-applicable",
              "testRun": "current"
            },
            "staleReasons": [],
            "unknownReasons": [
              "source-current-fingerprint-not-supplied",
              "test-current-fingerprint-not-supplied",
              "fixture-current-fingerprint-not-supplied",
              "environment-current-fingerprint-not-supplied",
              "server-measurement-unavailable:Cannot read properties of undefined (reading 'Latest')"
            ],
            "comparisonSupplied": false,
            "provenance": "not-supplied"
          }
        },
        {
          "id": 65306,
          "workItemId": "WI-6554700010008887",
          "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
          "specId": "AUTO-BAR-R-34-P-008",
          "sourceValId": null,
          "specRevision": 1,
          "currentRevision": 1,
          "specFingerprint": "c0b85504df60ba7f2ca47a4f3bd9249eeb9258d6e18d9f24474f052ab6fb987d",
          "evidenceKind": "test",
          "evidenceRef": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
          "fingerprints": {
            "sourceFingerprint": "sha256-file-set-v1:d77ddcdc736921dc57b8f996b0317b6b1c7969941e1f6364683bed83fa188574",
            "testFingerprint": "sha256-file-set-v1:f1739938687b792bbcb319999adbc0dc7e538558aafab8404e15580d7cb716b5",
            "fixtureFingerprint": "sha256-file-set-v1:26ee514eba2ce6a8dcd76ea42e5a30cffd1e8ccf98441f777d654bcb65800727",
            "rubricFingerprint": null,
            "environmentFingerprint": "0d386dbc6fc27c4db28faf292f571cb959ec36362a93ae4021a988437564090f"
          },
          "coverageEvidenceRef": null,
          "testRunId": 21338041,
          "testRunExecution": {
            "status": "pass",
            "passed": 3,
            "failed": 0,
            "skipped": 0,
            "collectionFailed": false,
            "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
            "scenarioId": "su-S41-scheduler-blocked",
            "passedCaseTitlesIncomplete": true,
            "testLayer": "llm"
          },
          "testRunProvenance": {
            "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
            "framework": "llm-test",
            "source": "local",
            "mutationPhase": null,
            "commitSha": "7a0aea1229adb3561b53c9a8cad47b9792711406",
            "worktreeDirty": false
          },
          "details": {
            "scope": "Completed hermetic S41v4 unit/original LLM scenario proof on committed 7a0aea1229adb3561b53c9a8cad47b9792711406. Synthetic inline world; no live loop delivery, external review pickup, R14 census, gate or shipment claim. Reused for AUTO-BAR-R-34-P-008 after exact working/HEAD/pinned equality of every source, test and fixture; original terminal item untouched.",
            "testRun": {
              "id": 21338041,
              "source": "local",
              "status": "pass",
              "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
              "commitSha": "7a0aea1229adb3561b53c9a8cad47b9792711406",
              "finishedAt": "2026-10-17T15:27:08.569Z",
              "asCommitted": {
                "commitSha": "7a0aea1229adb3561b53c9a8cad47b9792711406",
                "repoPrefix": "",
                "measuredAtCommit": true
              },
              "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-7a0aea1229-czV0uD",
              "mutationPhase": null,
              "worktreeDirty": false,
              "recordedFilePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
              "harnessAttribution": "run"
            },
            "adequacy": {
              "outcome": "passed",
              "skipped": false,
              "executed": true,
              "targeted": "auto-bar-r-34-p-008",
              "collected": true,
              "testCases": [
                "su-S41-scheduler-blocked"
              ],
              "testLayer": "llm",
              "fixtureFree": false,
              "scenarioIds": [
                "s41-blocked"
              ],
              "pathReachable": true,
              "fixtureCalibrated": true,
              "oracleIndependent": true
            },
            "proofRef": "artifact:papercusp/audits/parked-agent-resumption-2026-10-09/resume144-pinned-unit-model-mutation-proof-424d5.json",
            "calibration": {
              "negative": [
                "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":0,\"on_timeout\":\"wake\"}",
                "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":601,\"on_timeout\":\"wake\"}"
              ],
              "positive": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: blocked",
              "testRunId": 21338017,
              "inlineFixturePaths": [
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts"
              ]
            },
            "evidencePlane": "live",
            "originBinding": {
              "specId": "S41-BOUNDED-DEPENDENCY",
              "planSlug": "adhoc-work-item-specs",
              "bindingId": 54265
            },
            "measurementPin": {
              "files": [
                {
                  "path": "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
                  "repo": ".",
                  "clean": true,
                  "sha256": "bb108bbdc66b207a44155c6e3dfb6b37d85a4e3f3bffe3fdecafc6bfacb0301e",
                  "headBlob": "1420766e3acf71d1e99610963df770b45faf1313",
                  "dimension": "source"
                },
                {
                  "path": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
                  "repo": ".",
                  "clean": true,
                  "sha256": "92637eba5902dc27e899157db5e50516edcbe8dd1ae56c1dcd5d4fec60bf428b",
                  "headBlob": "f94c3928273cbd12fcda99c00024aaf7469acf2c",
                  "dimension": "source"
                },
                {
                  "path": "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
                  "repo": ".",
                  "clean": true,
                  "sha256": "8b08b2336b5046b985edee0914b9bff88319b32aaffd1cf62bca8e75c7e11427",
                  "headBlob": "ed65fdaf7e6c7c9e300c6c3ba52769bca82084ef",
                  "dimension": "source"
                },
                {
                  "path": "packages/operator-core/lib/scheduler/fleet-scope-admission.ts",
                  "repo": ".",
                  "clean": true,
                  "sha256": "7e5653d51dfd705a3b9a766198a4460a8d5dafa8af6228d2873c2baab6a27de1",
                  "headBlob": "94aa161adecb2612055a239d3589d0fc9a69dbd5",
                  "dimension": "source"
                },
                {
                  "path": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
                  "repo": ".",
                  "clean": true,
                  "sha256": "92637eba5902dc27e899157db5e50516edcbe8dd1ae56c1dcd5d4fec60bf428b",
                  "headBlob": "f94c3928273cbd12fcda99c00024aaf7469acf2c",
                  "dimension": "test"
                },
                {
                  "path": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
                  "repo": ".",
                  "clean": true,
                  "sha256": "ed6005447069830a4b130d6f8c2c99e00cadf892fb27b5bc93aa43f720928705",
                  "headBlob": "c99da02d96f11078266e737fc8a4acf922765e35",
                  "dimension": "fixture"
                },
                {
                  "path": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
                  "repo": ".",
                  "clean": true,
                  "sha256": "92637eba5902dc27e899157db5e50516edcbe8dd1ae56c1dcd5d4fec60bf428b",
                  "headBlob": "f94c3928273cbd12fcda99c00024aaf7469acf2c",
                  "dimension": "fixture"
                }
              ],
              "repos": [
                {
                  "head": "d32eae0110551750ed8698297b5f8851e94fd4e0",
                  "repo": ".",
                  "gitlink": null
                }
              ],
              "schemaVersion": 1
            },
            "oracleRationale": "Expected properties are independently authored from S41-BOUNDED-DEPENDENCY / P-008 / D-009: retain the claim and establish the exact positive bounded dependency wake before any loop stop. The oracle replays observed tool effects and ordering, and does not copy fleetScopedMiss advice or trust SUT narrative. The unit suite accepts a valid trace and rejects the corresponding invalid trace; copy-out mutation 21338077 causes these exact negative guard cases to fail after passing baseline and copy baseline.",
            "currentMeasurement": {
              "kind": "repo-files",
              "testPaths": [
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts"
              ],
              "sourcePaths": [
                "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
                "packages/operator-core/lib/scheduler/fleet-scope-admission.ts"
              ],
              "fixturePaths": [
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts"
              ],
              "runtimeUnits": [
                "llm-test-in-process-959719"
              ],
              "schemaVersion": 1,
              "completedRuntime": {
                "kind": "llm-in-process"
              }
            },
            "runtimePlaneMeaning": "live labels the originally observed hermetic in-process witness certified through completedRuntime; no present PID, serving deployment or live-loop delivery is asserted."
          },
          "observedAt": "2026-10-22T23:17:03.852Z",
          "bindingFingerprint": "ec2b83378a887a62566234ec1f462691ed74482773d2d8caa55e9308927fade7",
          "createdBy": "su-424d5476-0b13-401a-a926-0aaa9f212391",
          "createdAt": "2026-10-22T23:17:03.589Z",
          "serverMeasurement": {
            "status": "unavailable",
            "reason": "Cannot read properties of undefined (reading 'Latest')"
          },
          "currentness": {
            "overall": "unknown",
            "dimensions": {
              "spec": "current",
              "source": "unknown",
              "test": "unknown",
              "fixture": "unknown",
              "rubric": "not-applicable",
              "environment": "unknown",
              "coverageEvidence": "not-applicable",
              "testRun": "current"
            },
            "staleReasons": [],
            "unknownReasons": [
              "source-current-fingerprint-not-supplied",
              "test-current-fingerprint-not-supplied",
              "fixture-current-fingerprint-not-supplied",
              "environment-current-fingerprint-not-supplied",
              "server-measurement-unavailable:Cannot read properties of undefined (reading 'Latest')"
            ],
            "comparisonSupplied": false,
            "provenance": "not-supplied"
          }
        },
        {
          "id": 65305,
          "workItemId": "WI-6554700010008887",
          "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
          "specId": "AUTO-BAR-R-32-P-008",
          "sourceValId": null,
          "specRevision": 1,
          "currentRevision": 1,
          "specFingerprint": "53994729feb67fccdbf6a2616898d415aa8e167ac1eb3cbbc0f100524e08cdd9",
          "evidenceKind": "test",
          "evidenceRef": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
          "fingerprints": {
            "sourceFingerprint": "sha256-file-set-v1:d77ddcdc736921dc57b8f996b0317b6b1c7969941e1f6364683bed83fa188574",
            "testFingerprint": "sha256-file-set-v1:f1739938687b792bbcb319999adbc0dc7e538558aafab8404e15580d7cb716b5",
            "fixtureFingerprint": "sha256-file-set-v1:26ee514eba2ce6a8dcd76ea42e5a30cffd1e8ccf98441f777d654bcb65800727",
            "rubricFingerprint": null,
            "environmentFingerprint": "ff0fb4eb0b68e8cac4c900ab0585655bbbef4c76aef698a8462b0249fe378fe4"
          },
          "coverageEvidenceRef": null,
          "testRunId": 21338029,
          "testRunExecution": {
            "status": "pass",
            "passed": 3,
            "failed": 0,
            "skipped": 0,
            "collectionFailed": false,
            "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
            "scenarioId": "su-S41-scheduler-no-event",
            "passedCaseTitlesIncomplete": true,
            "testLayer": "llm"
          },
          "testRunProvenance": {
            "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
            "framework": "llm-test",
            "source": "local",
            "mutationPhase": null,
            "commitSha": "7a0aea1229adb3561b53c9a8cad47b9792711406",
            "worktreeDirty": false
          },
          "details": {
            "scope": "Completed hermetic S41v4 unit/original LLM scenario proof on committed 7a0aea1229adb3561b53c9a8cad47b9792711406. Synthetic inline world; no live loop delivery, external review pickup, R14 census, gate or shipment claim. Reused for AUTO-BAR-R-32-P-008 after exact working/HEAD/pinned equality of every source, test and fixture; original terminal item untouched.",
            "testRun": {
              "id": 21338029,
              "source": "local",
              "status": "pass",
              "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
              "commitSha": "7a0aea1229adb3561b53c9a8cad47b9792711406",
              "finishedAt": "2026-10-17T15:26:33.212Z",
              "asCommitted": {
                "commitSha": "7a0aea1229adb3561b53c9a8cad47b9792711406",
                "repoPrefix": "",
                "measuredAtCommit": true
              },
              "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-7a0aea1229-czV0uD",
              "mutationPhase": null,
              "worktreeDirty": false,
              "recordedFilePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
              "harnessAttribution": "run"
            },
            "adequacy": {
              "outcome": "passed",
              "skipped": false,
              "executed": true,
              "targeted": "auto-bar-r-32-p-008",
              "collected": true,
              "testCases": [
                "su-S41-scheduler-no-event"
              ],
              "testLayer": "llm",
              "fixtureFree": false,
              "scenarioIds": [
                "s41-no-event"
              ],
              "pathReachable": true,
              "fixtureCalibrated": true,
              "oracleIndependent": true
            },
            "proofRef": "artifact:papercusp/audits/parked-agent-resumption-2026-10-09/resume144-pinned-unit-model-mutation-proof-424d5.json",
            "calibration": {
              "negative": [
                "S41 actual scheduler advice behavior instrument > rejects a backlog watch as retained-work wake, release of held work, invented blockers and duplicate loops",
                "S41 actual scheduler advice behavior instrument > rejects the observed fabricated peer-review ref without creating a dependency or stopping its loop"
              ],
              "positive": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: no-event",
              "testRunId": 21338017,
              "inlineFixturePaths": [
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts"
              ]
            },
            "evidencePlane": "live",
            "originBinding": {
              "specId": "S41-MISSING-EVENT",
              "planSlug": "adhoc-work-item-specs",
              "bindingId": 54267
            },
            "measurementPin": {
              "files": [
                {
                  "path": "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
                  "repo": ".",
                  "clean": true,
                  "sha256": "bb108bbdc66b207a44155c6e3dfb6b37d85a4e3f3bffe3fdecafc6bfacb0301e",
                  "headBlob": "1420766e3acf71d1e99610963df770b45faf1313",
                  "dimension": "source"
                },
                {
                  "path": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
                  "repo": ".",
                  "clean": true,
                  "sha256": "92637eba5902dc27e899157db5e50516edcbe8dd1ae56c1dcd5d4fec60bf428b",
                  "headBlob": "f94c3928273cbd12fcda99c00024aaf7469acf2c",
                  "dimension": "source"
                },
                {
                  "path": "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
                  "repo": ".",
                  "clean": true,
                  "sha256": "8b08b2336b5046b985edee0914b9bff88319b32aaffd1cf62bca8e75c7e11427",
                  "headBlob": "ed65fdaf7e6c7c9e300c6c3ba52769bca82084ef",
                  "dimension": "source"
                },
                {
                  "path": "packages/operator-core/lib/scheduler/fleet-scope-admission.ts",
                  "repo": ".",
                  "clean": true,
                  "sha256": "7e5653d51dfd705a3b9a766198a4460a8d5dafa8af6228d2873c2baab6a27de1",
                  "headBlob": "94aa161adecb2612055a239d3589d0fc9a69dbd5",
                  "dimension": "source"
                },
                {
                  "path": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
                  "repo": ".",
                  "clean": true,
                  "sha256": "92637eba5902dc27e899157db5e50516edcbe8dd1ae56c1dcd5d4fec60bf428b",
                  "headBlob": "f94c3928273cbd12fcda99c00024aaf7469acf2c",
                  "dimension": "test"
                },
                {
                  "path": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
                  "repo": ".",
                  "clean": true,
                  "sha256": "ed6005447069830a4b130d6f8c2c99e00cadf892fb27b5bc93aa43f720928705",
                  "headBlob": "c99da02d96f11078266e737fc8a4acf922765e35",
                  "dimension": "fixture"
                },
                {
                  "path": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
                  "repo": ".",
                  "clean": true,
                  "sha256": "92637eba5902dc27e899157db5e50516edcbe8dd1ae56c1dcd5d4fec60bf428b",
                  "headBlob": "f94c3928273cbd12fcda99c00024aaf7469acf2c",
                  "dimension": "fixture"
                }
              ],
              "repos": [
                {
                  "head": "d32eae0110551750ed8698297b5f8851e94fd4e0",
                  "repo": ".",
                  "gitlink": null
                }
              ],
              "schemaVersion": 1
            },
            "oracleRationale": "Expected properties are independently authored from S41-MISSING-EVENT / P-008 / D-009: preserve the existing loop and checkpoint without inventing a dependency. The oracle replays observed tool effects and ordering, and does not copy fleetScopedMiss advice or trust SUT narrative. The unit suite accepts a valid trace and rejects the corresponding invalid trace; copy-out mutation 21338076 causes these exact negative guard cases to fail after passing baseline and copy baseline.",
            "currentMeasurement": {
              "kind": "repo-files",
              "testPaths": [
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts"
              ],
              "sourcePaths": [
                "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
                "packages/operator-core/lib/scheduler/fleet-scope-admission.ts"
              ],
              "fixturePaths": [
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts"
              ],
              "runtimeUnits": [
                "llm-test-in-process-959628"
              ],
              "schemaVersion": 1,
              "completedRuntime": {
                "kind": "llm-in-process"
              }
            },
            "runtimePlaneMeaning": "live labels the originally observed hermetic in-process witness certified through completedRuntime; no present PID, serving deployment or live-loop delivery is asserted."
          },
          "observedAt": "2026-10-22T23:17:01.566Z",
          "bindingFingerprint": "a72f1484b858f88c2d8daaa4c8c27a3936f826b3a9eed8773669f51ffbe86b5b",
          "createdBy": "su-424d5476-0b13-401a-a926-0aaa9f212391",
          "createdAt": "2026-10-22T23:17:00.960Z",
          "serverMeasurement": {
            "status": "unavailable",
            "reason": "Cannot read properties of undefined (reading 'Latest')"
          },
          "currentness": {
            "overall": "unknown",
            "dimensions": {
              "spec": "current",
              "source": "unknown",
              "test": "unknown",
              "fixture": "unknown",
              "rubric": "not-applicable",
              "environment": "unknown",
              "coverageEvidence": "not-applicable",
              "testRun": "current"
            },
            "staleReasons": [],
            "unknownReasons": [
              "source-current-fingerprint-not-supplied",
              "test-current-fingerprint-not-supplied",
              "fixture-current-fingerprint-not-supplied",
              "environment-current-fingerprint-not-supplied",
              "server-measurement-unavailable:Cannot read properties of undefined (reading 'Latest')"
            ],
            "comparisonSupplied": false,
            "provenance": "not-supplied"
          }
        },
        {
          "id": 65304,
          "workItemId": "WI-6554700010008887",
          "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
          "specId": "AUTO-BAR-R-32-P-008",
          "sourceValId": null,
          "specRevision": 1,
          "currentRevision": 1,
          "specFingerprint": "53994729feb67fccdbf6a2616898d415aa8e167ac1eb3cbbc0f100524e08cdd9",
          "evidenceKind": "test",
          "evidenceRef": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
          "fingerprints": {
            "sourceFingerprint": "sha256-file-set-v1:d77ddcdc736921dc57b8f996b0317b6b1c7969941e1f6364683bed83fa188574",
            "testFingerprint": "sha256-file-set-v1:f1739938687b792bbcb319999adbc0dc7e538558aafab8404e15580d7cb716b5",
            "fixtureFingerprint": "sha256-file-set-v1:26ee514eba2ce6a8dcd76ea42e5a30cffd1e8ccf98441f777d654bcb65800727",
            "rubricFingerprint": null,
            "environmentFingerprint": "97993997ad83009cf3dfe7b1d6d5b07c4d1fe9583a566a9420e99eb8d6122f62"
          },
          "coverageEvidenceRef": null,
          "testRunId": 21338043,
          "testRunExecution": {
            "status": "pass",
            "passed": 3,
            "failed": 0,
            "skipped": 0,
            "collectionFailed": false,
            "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
            "scenarioId": "su-S41-scheduler-finished",
            "passedCaseTitlesIncomplete": true,
            "testLayer": "llm"
          },
          "testRunProvenance": {
            "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
            "framework": "llm-test",
            "source": "local",
            "mutationPhase": null,
            "commitSha": "7a0aea1229adb3561b53c9a8cad47b9792711406",
            "worktreeDirty": false
          },
          "details": {
            "scope": "Completed hermetic S41v4 unit/original LLM scenario proof on committed 7a0aea1229adb3561b53c9a8cad47b9792711406. Synthetic inline world; no live loop delivery, external review pickup, R14 census, gate or shipment claim. Reused for AUTO-BAR-R-32-P-008 after exact working/HEAD/pinned equality of every source, test and fixture; original terminal item untouched.",
            "testRun": {
              "id": 21338043,
              "source": "local",
              "status": "pass",
              "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
              "commitSha": "7a0aea1229adb3561b53c9a8cad47b9792711406",
              "finishedAt": "2026-10-17T15:27:06.949Z",
              "asCommitted": {
                "commitSha": "7a0aea1229adb3561b53c9a8cad47b9792711406",
                "repoPrefix": "",
                "measuredAtCommit": true
              },
              "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-7a0aea1229-czV0uD",
              "mutationPhase": null,
              "worktreeDirty": false,
              "recordedFilePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
              "harnessAttribution": "run"
            },
            "adequacy": {
              "outcome": "passed",
              "skipped": false,
              "executed": true,
              "targeted": "auto-bar-r-32-p-008",
              "collected": true,
              "testCases": [
                "su-S41-scheduler-finished"
              ],
              "testLayer": "llm",
              "fixtureFree": false,
              "scenarioIds": [
                "s41-finished"
              ],
              "pathReachable": true,
              "fixtureCalibrated": true,
              "oracleIndependent": true
            },
            "proofRef": "artifact:papercusp/audits/parked-agent-resumption-2026-10-09/resume144-pinned-unit-model-mutation-proof-424d5.json",
            "calibration": {
              "negative": [
                "S41 actual scheduler advice behavior instrument > calibration: finished work stops, while missing-event work checkpoints and keeps its loop"
              ],
              "positive": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: finished",
              "testRunId": 21338017,
              "inlineFixturePaths": [
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts"
              ]
            },
            "evidencePlane": "live",
            "originBinding": {
              "specId": "S41-FINISHED-STOP",
              "planSlug": "adhoc-work-item-specs",
              "bindingId": 54269
            },
            "measurementPin": {
              "files": [
                {
                  "path": "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
                  "repo": ".",
                  "clean": true,
                  "sha256": "bb108bbdc66b207a44155c6e3dfb6b37d85a4e3f3bffe3fdecafc6bfacb0301e",
                  "headBlob": "1420766e3acf71d1e99610963df770b45faf1313",
                  "dimension": "source"
                },
                {
                  "path": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
                  "repo": ".",
                  "clean": true,
                  "sha256": "92637eba5902dc27e899157db5e50516edcbe8dd1ae56c1dcd5d4fec60bf428b",
                  "headBlob": "f94c3928273cbd12fcda99c00024aaf7469acf2c",
                  "dimension": "source"
                },
                {
                  "path": "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
                  "repo": ".",
                  "clean": true,
                  "sha256": "8b08b2336b5046b985edee0914b9bff88319b32aaffd1cf62bca8e75c7e11427",
                  "headBlob": "ed65fdaf7e6c7c9e300c6c3ba52769bca82084ef",
                  "dimension": "source"
                },
                {
                  "path": "packages/operator-core/lib/scheduler/fleet-scope-admission.ts",
                  "repo": ".",
                  "clean": true,
                  "sha256": "7e5653d51dfd705a3b9a766198a4460a8d5dafa8af6228d2873c2baab6a27de1",
                  "headBlob": "94aa161adecb2612055a239d3589d0fc9a69dbd5",
                  "dimension": "source"
                },
                {
                  "path": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
                  "repo": ".",
                  "clean": true,
                  "sha256": "92637eba5902dc27e899157db5e50516edcbe8dd1ae56c1dcd5d4fec60bf428b",
                  "headBlob": "f94c3928273cbd12fcda99c00024aaf7469acf2c",
                  "dimension": "test"
                },
                {
                  "path": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
                  "repo": ".",
                  "clean": true,
                  "sha256": "ed6005447069830a4b130d6f8c2c99e00cadf892fb27b5bc93aa43f720928705",
                  "headBlob": "c99da02d96f11078266e737fc8a4acf922765e35",
                  "dimension": "fixture"
                },
                {
                  "path": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
                  "repo": ".",
                  "clean": true,
                  "sha256": "92637eba5902dc27e899157db5e50516edcbe8dd1ae56c1dcd5d4fec60bf428b",
                  "headBlob": "f94c3928273cbd12fcda99c00024aaf7469acf2c",
                  "dimension": "fixture"
                }
              ],
              "repos": [
                {
                  "head": "d32eae0110551750ed8698297b5f8851e94fd4e0",
                  "repo": ".",
                  "gitlink": null
                }
              ],
              "schemaVersion": 1
            },
            "oracleRationale": "Expected properties are independently authored from S41-FINISHED-STOP / P-008 / D-009: stop the existing loop only after all requested work is complete and no retained obligation remains. The oracle replays observed tool effects and ordering, and does not copy fleetScopedMiss advice or trust SUT narrative. The unit suite accepts a valid trace and rejects the corresponding invalid trace; copy-out mutation 21338051 causes these exact negative guard cases to fail after passing baseline and copy baseline.",
            "currentMeasurement": {
              "kind": "repo-files",
              "testPaths": [
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts"
              ],
              "sourcePaths": [
                "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
                "packages/operator-core/lib/scheduler/fleet-scope-admission.ts"
              ],
              "fixturePaths": [
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
                "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts"
              ],
              "runtimeUnits": [
                "llm-test-in-process-959721"
              ],
              "schemaVersion": 1,
              "completedRuntime": {
                "kind": "llm-in-process"
              }
            },
            "runtimePlaneMeaning": "live labels the originally observed hermetic in-process witness certified through completedRuntime; no present PID, serving deployment or live-loop delivery is asserted."
          },
          "observedAt": "2026-10-22T23:16:58.500Z",
          "bindingFingerprint": "2dbfd61abb736fb4055f79f7f66c6b501d0fa0595a75393f15979fe8ddc7cd21",
          "createdBy": "su-424d5476-0b13-401a-a926-0aaa9f212391",
          "createdAt": "2026-10-22T23:16:58.073Z",
          "serverMeasurement": {
            "status": "unavailable",
            "reason": "Cannot read properties of undefined (reading 'Latest')"
          },
          "currentness": {
            "overall": "unknown",
            "dimensions": {
              "spec": "current",
              "source": "unknown",
              "test": "unknown",
              "fixture": "unknown",
              "rubric": "not-applicable",
              "environment": "unknown",
              "coverageEvidence": "not-applicable",
              "testRun": "current"
            },
            "staleReasons": [],
            "unknownReasons": [
              "source-current-fingerprint-not-supplied",
              "test-current-fingerprint-not-supplied",
              "fixture-current-fingerprint-not-supplied",
              "environment-current-fingerprint-not-supplied",
              "server-measurement-unavailable:Cannot read properties of undefined (reading 'Latest')"
            ],
            "comparisonSupplied": false,
            "provenance": "not-supplied"
          }
        },
        {
          "id": 65303,
          "workItemId": "WI-6554700010008887",
          "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
          "specId": "AUTO-BAR-R-28-P-004",
          "sourceValId": null,
          "specRevision": 1,
          "currentRevision": 1,
          "specFingerprint": "3fea0b2cd75a6671d1cef8b490c8359c5ed4670083b6bf78417653c8b85acf3c",
          "evidenceKind": "test",
          "evidenceRef": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
          "fingerprints": {
            "sourceFingerprint": "sha256-file-set-v1:42e4f6d36e61cec514ad534b07e6c4deeee1f3b2062d54b8803e48f711b9b946",
            "testFingerprint": "sha256-file-set-v1:a0e6c1394e394061065526a673c1a895d098a5b6c1efe6f39a9859615b8674f4",
            "fixtureFingerprint": null,
            "rubricFingerprint": null,
            "environmentFingerprint": null
          },
          "coverageEvidenceRef": null,
          "testRunId": 21784916,
          "testRunExecution": {
            "status": "pass",
            "passed": 5,
            "failed": 0,
            "skipped": 16,
            "collectionFailed": false,
            "testNamePattern": "renders loop:end only|renders continue-independent|renders a bounded exact-event|leaves a disarmed actionable AUTO|host discovery quota reset publication",
            "filePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
            "passedCaseTitles": [
              "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['absolute local time']",
              "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['relative duration']",
              "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['ANSI and wrapped output']",
              "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['newest statement']",
              "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['no stated reset']"
            ],
            "testLayer": "unit"
          },
          "testRunProvenance": {
            "filePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
            "framework": "vitest",
            "source": "admin-ui",
            "mutationPhase": null,
            "commitSha": "1d63e8bf049543d7b49fdc700d5470203f949e53",
            "worktreeDirty": true
          },
          "details": {
            "scope": "Five named R28 host discovery writer cases only; 16 sibling cases filtered. Source and test equal the committed bytes of the original test run. No provider reset or live recovery claim. Exact declared case identities recovered from canonical testing:runs; fixture calibration and falsifiability remain unasserted for this row.",
            "testRun": {
              "id": 21784916,
              "source": "admin-ui",
              "status": "pass",
              "filePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
              "commitSha": "1d63e8bf049543d7b49fdc700d5470203f949e53",
              "finishedAt": "2026-10-22T21:11:07.621Z",
              "recordedRoot": "/home/marsh-office/papercupai-workspace/papercusp",
              "mutationPhase": null,
              "worktreeDirty": true,
              "recordedFilePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
              "harnessAttribution": "run"
            },
            "adequacy": {
              "outcome": "passed",
              "skipped": false,
              "executed": true,
              "targeted": "auto-bar-r-28-p-004",
              "collected": true,
              "testCases": [
                "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['absolute local time']",
                "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['relative duration']",
                "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['ANSI and wrapped output']",
                "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['newest statement']",
                "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['no stated reset']"
              ],
              "testLayer": "unit"
            },
            "evidencePlane": "tree",
            "measurementPin": {
              "files": [
                {
                  "path": "apps/operator/scripts/psu-pty-host.mjs",
                  "repo": ".",
                  "clean": true,
                  "sha256": "eaea562f234c52b6fc11218769d0103846f09d81203c39453d710c88b0c82d25",
                  "headBlob": "4adf7aebe37369ac9b7a1f9f622d4729885c0a0e",
                  "dimension": "source"
                },
                {
                  "path": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
                  "repo": ".",
                  "clean": true,
                  "sha256": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
                  "headBlob": "ebd760b141c69bb216ab1ddf788e6ef3a9366c37",
                  "dimension": "test"
                }
              ],
              "repos": [
                {
                  "head": "d32eae0110551750ed8698297b5f8851e94fd4e0",
                  "repo": ".",
                  "gitlink": null
                }
              ],
              "schemaVersion": 1
            },
            "currentMeasurement": {
              "kind": "repo-files",
              "testPaths": [
                "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts"
              ],
              "sourcePaths": [
                "apps/operator/scripts/psu-pty-host.mjs"
              ],
              "schemaVersion": 1
            }
          },
          "observedAt": "2026-10-22T23:16:56.983Z",
          "bindingFingerprint": "48c5824bdf4f3c8680fbe4f36ef77d5f0b36ec0224b1dbf15189bbd54422dfb6",
          "createdBy": "su-424d5476-0b13-401a-a926-0aaa9f212391",
          "createdAt": "2026-10-22T23:16:56.624Z",
          "serverMeasurement": {
            "status": "unavailable",
            "reason": "Cannot read properties of undefined (reading 'Latest')"
          },
          "currentness": {
            "overall": "unknown",
            "dimensions": {
              "spec": "current",
              "source": "unknown",
              "test": "unknown",
              "fixture": "not-applicable",
              "rubric": "not-applicable",
              "environment": "not-applicable",
              "coverageEvidence": "not-applicable",
              "testRun": "unknown"
            },
            "staleReasons": [],
            "unknownReasons": [
              "source-current-fingerprint-not-supplied",
              "test-current-fingerprint-not-supplied",
              "test-run-worktree-not-clean",
              "server-measurement-unavailable:Cannot read properties of undefined (reading 'Latest')"
            ],
            "comparisonSupplied": false,
            "provenance": "not-supplied"
          }
        },
        {
          "id": 65302,
          "workItemId": "WI-6554700010008887",
          "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
          "specId": "AUTO-BAR-R-28-P-012",
          "sourceValId": null,
          "specRevision": 1,
          "currentRevision": 1,
          "specFingerprint": "e7f2e78332c5e9377bc89e2e949b9d4bd39b4a8fa60a074d4b16dcdb9510ab50",
          "evidenceKind": "test",
          "evidenceRef": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
          "fingerprints": {
            "sourceFingerprint": "sha256-file-set-v1:42e4f6d36e61cec514ad534b07e6c4deeee1f3b2062d54b8803e48f711b9b946",
            "testFingerprint": "sha256-file-set-v1:a0e6c1394e394061065526a673c1a895d098a5b6c1efe6f39a9859615b8674f4",
            "fixtureFingerprint": null,
            "rubricFingerprint": null,
            "environmentFingerprint": null
          },
          "coverageEvidenceRef": null,
          "testRunId": 21784916,
          "testRunExecution": {
            "status": "pass",
            "passed": 5,
            "failed": 0,
            "skipped": 16,
            "collectionFailed": false,
            "testNamePattern": "renders loop:end only|renders continue-independent|renders a bounded exact-event|leaves a disarmed actionable AUTO|host discovery quota reset publication",
            "filePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
            "passedCaseTitles": [
              "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['absolute local time']",
              "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['relative duration']",
              "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['ANSI and wrapped output']",
              "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['newest statement']",
              "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['no stated reset']"
            ],
            "testLayer": "unit"
          },
          "testRunProvenance": {
            "filePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
            "framework": "vitest",
            "source": "admin-ui",
            "mutationPhase": null,
            "commitSha": "1d63e8bf049543d7b49fdc700d5470203f949e53",
            "worktreeDirty": true
          },
          "details": {
            "scope": "Five named R28 host discovery writer cases only; 16 sibling cases filtered. Source and test equal the committed bytes of the original test run. No provider reset or live recovery claim. Exact declared case identities recovered from canonical testing:runs; fixture calibration and falsifiability remain unasserted for this row.",
            "testRun": {
              "id": 21784916,
              "source": "admin-ui",
              "status": "pass",
              "filePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
              "commitSha": "1d63e8bf049543d7b49fdc700d5470203f949e53",
              "finishedAt": "2026-10-22T21:11:07.621Z",
              "recordedRoot": "/home/marsh-office/papercupai-workspace/papercusp",
              "mutationPhase": null,
              "worktreeDirty": true,
              "recordedFilePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
              "harnessAttribution": "run"
            },
            "adequacy": {
              "outcome": "passed",
              "skipped": false,
              "executed": true,
              "targeted": "auto-bar-r-28-p-012",
              "collected": true,
              "testCases": [
                "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['absolute local time']",
                "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['relative duration']",
                "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['ANSI and wrapped output']",
                "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['newest statement']",
                "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['no stated reset']"
              ],
              "testLayer": "unit"
            },
            "evidencePlane": "tree",
            "measurementPin": {
              "files": [
                {
                  "path": "apps/operator/scripts/psu-pty-host.mjs",
                  "repo": ".",
                  "clean": true,
                  "sha256": "eaea562f234c52b6fc11218769d0103846f09d81203c39453d710c88b0c82d25",
                  "headBlob": "4adf7aebe37369ac9b7a1f9f622d4729885c0a0e",
                  "dimension": "source"
                },
                {
                  "path": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
                  "repo": ".",
                  "clean": true,
                  "sha256": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
                  "headBlob": "ebd760b141c69bb216ab1ddf788e6ef3a9366c37",
                  "dimension": "test"
                }
              ],
              "repos": [
                {
                  "head": "d32eae0110551750ed8698297b5f8851e94fd4e0",
                  "repo": ".",
                  "gitlink": null
                }
              ],
              "schemaVersion": 1
            },
            "currentMeasurement": {
              "kind": "repo-files",
              "testPaths": [
                "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts"
              ],
              "sourcePaths": [
                "apps/operator/scripts/psu-pty-host.mjs"
              ],
              "schemaVersion": 1
            }
          },
          "observedAt": "2026-10-22T23:16:55.647Z",
          "bindingFingerprint": "7c5776e93333be84c6f86c48648453a56ac05cf42d18c577365b93ad15b127a8",
          "createdBy": "su-424d5476-0b13-401a-a926-0aaa9f212391",
          "createdAt": "2026-10-22T23:16:55.417Z",
          "serverMeasurement": {
            "status": "unavailable",
            "reason": "Cannot read properties of undefined (reading 'Latest')"
          },
          "currentness": {
            "overall": "unknown",
            "dimensions": {
              "spec": "current",
              "source": "unknown",
              "test": "unknown",
              "fixture": "not-applicable",
              "rubric": "not-applicable",
              "environment": "not-applicable",
              "coverageEvidence": "not-applicable",
              "testRun": "unknown"
            },
            "staleReasons": [],
            "unknownReasons": [
              "source-current-fingerprint-not-supplied",
              "test-current-fingerprint-not-supplied",
              "test-run-worktree-not-clean",
              "server-measurement-unavailable:Cannot read properties of undefined (reading 'Latest')"
            ],
            "comparisonSupplied": false,
            "provenance": "not-supplied"
          }
        },
        {
          "id": 65281,
          "workItemId": "WI-6554700010008887",
          "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
          "specId": "AUTO-BAR-R-34-P-008",
          "sourceValId": null,
          "specRevision": 1,
          "currentRevision": 1,
          "specFingerprint": "c0b85504df60ba7f2ca47a4f3bd9249eeb9258d6e18d9f24474f052ab6fb987d",
          "evidenceKind": "test",
          "evidenceRef": "packages/operator-core/lib/scheduler/fleet-scope-admission.test.ts",
          "fingerprints": {
            "sourceFingerprint": "sha256-file-set-v1:aa907f78479eb8cc448732b37a1b035997902169f499f4c9d8941f27445c0ce8",
            "testFingerprint": "sha256-file-set-v1:997551f2d10917eeb4c8a6ce32c523a8ee07bf7f5e9635d3afa8bfe819a8b5c9",
            "fixtureFingerprint": null,
            "rubricFingerprint": null,
            "environmentFingerprint": null
          },
          "coverageEvidenceRef": null,
          "testRunId": 21784912,
          "testRunExecution": {
            "status": "pass",
            "passed": 3,
            "failed": 0,
            "skipped": 169,
            "collectionFailed": false,
            "testNamePattern": "renders loop:end only|renders continue-independent|renders a bounded exact-event|leaves a disarmed actionable AUTO|host discovery quota reset publication",
            "filePath": "packages/operator-core/lib/scheduler/fleet-scope-admission.test.ts",
            "passedCaseTitles": [],
            "testLayer": "unit",
            "passedCaseTitleCount": 3,
            "passedCaseTitlesOmitted": 3,
            "passedCaseTitlesRef": {
              "tool": "testing:runs",
              "args": {
                "testRunIds": [
                  21784912
                ],
                "cases": true
              }
            }
          },
          "testRunProvenance": {
            "filePath": "packages/operator-core/lib/scheduler/fleet-scope-admission.test.ts",
            "framework": "vitest",
            "source": "admin-ui",
            "mutationPhase": null,
            "commitSha": "1d63e8bf049543d7b49fdc700d5470203f949e53",
            "worktreeDirty": true
          },
          "details": {
            "scope": "Three named rendered-guidance cases only;169 sibling cases filtered. Committed source and test exactly equal original run commit. No scheduler runtime or whole-file acceptance.",
            "testRun": {
              "id": 21784912,
              "source": "admin-ui",
              "status": "pass",
              "filePath": "packages/operator-core/lib/scheduler/fleet-scope-admission.test.ts",
              "commitSha": "1d63e8bf049543d7b49fdc700d5470203f949e53",
              "finishedAt": "2026-10-22T21:10:39.149Z",
              "recordedRoot": "/home/marsh-office/papercupai-workspace/papercusp",
              "mutationPhase": null,
              "worktreeDirty": true,
              "recordedFilePath": "packages/operator-core/lib/scheduler/fleet-scope-admission.test.ts",
              "harnessAttribution": "run"
            },
            "adequacy": {
              "outcome": "passed",
              "skipped": false,
              "executed": true,
              "collected": true,
              "testLayer": "unit"
            },
            "measurementPin": {
              "files": [
                {
                  "path": "packages/operator-core/lib/scheduler/fleet-scope-admission.ts",
                  "repo": ".",
                  "clean": true,
                  "sha256": "7e5653d51dfd705a3b9a766198a4460a8d5dafa8af6228d2873c2baab6a27de1",
                  "headBlob": "94aa161adecb2612055a239d3589d0fc9a69dbd5",
                  "dimension": "source"
                },
                {
                  "path": "packages/operator-core/lib/scheduler/fleet-scope-admission.test.ts",
                  "repo": ".",
                  "clean": true,
                  "sha256": "01ea996376f9bf274b581707d0ef12cc3aa7cee613c789b06121486da6eab9aa",
                  "headBlob": "8609781dd8a8a63df2274b79e8b17b1922689a35",
                  "dimension": "test"
                }
              ],
              "repos": [
                {
                  "head": "d32eae0110551750ed8698297b5f8851e94fd4e0",
                  "repo": ".",
                  "gitlink": null
                }
              ],
              "schemaVersion": 1
            },
            "currentMeasurement": {
              "kind": "repo-files",
              "testPaths": [
                "packages/operator-core/lib/scheduler/fleet-scope-admission.test.ts"
              ],
              "sourcePaths": [
                "packages/operator-core/lib/scheduler/fleet-scope-admission.ts"
              ],
              "schemaVersion": 1
            }
          },
          "observedAt": "2026-10-22T22:31:47.836Z",
          "bindingFingerprint": "6cdd3817f9659c94cae7086b78e1f8e26bbc83ca3a4d4f63d7e37237248949a5",
          "createdBy": "su-424d5476-0b13-401a-a926-0aaa9f212391",
          "createdAt": "2026-10-22T22:31:47.821Z",
          "serverMeasurement": {
            "status": "unavailable",
            "reason": "Cannot read properties of undefined (reading 'Latest')"
          },
          "currentness": {
            "overall": "unknown",
            "dimensions": {
              "spec": "current",
              "source": "unknown",
              "test": "unknown",
              "fixture": "not-applicable",
              "rubric": "not-applicable",
              "environment": "not-applicable",
              "coverageEvidence": "not-applicable",
              "testRun": "unknown"
            },
            "staleReasons": [],
            "unknownReasons": [
              "source-current-fingerprint-not-supplied",
              "test-current-fingerprint-not-supplied",
              "test-run-worktree-not-clean",
              "server-measurement-unavailable:Cannot read properties of undefined (reading 'Latest')"
            ],
            "comparisonSupplied": false,
            "provenance": "not-supplied"
          }
        },
        {
          "id": 65280,
          "workItemId": "WI-6554700010008887",
          "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
          "specId": "AUTO-BAR-R-33-P-008",
          "sourceValId": null,
          "specRevision": 1,
          "currentRevision": 1,
          "specFingerprint": "b14f5695f8fad63f9724bbd5ab3d125673e8c4b0f5b3b4a491eaaead6dd0c8de",
          "evidenceKind": "test",
          "evidenceRef": "packages/operator-core/lib/scheduler/fleet-scope-admission.test.ts",
          "fingerprints": {
            "sourceFingerprint": "sha256-file-set-v1:aa907f78479eb8cc448732b37a1b035997902169f499f4c9d8941f27445c0ce8",
            "testFingerprint": "sha256-file-set-v1:997551f2d10917eeb4c8a6ce32c523a8ee07bf7f5e9635d3afa8bfe819a8b5c9",
            "fixtureFingerprint": null,
            "rubricFingerprint": null,
            "environmentFingerprint": null
          },
          "coverageEvidenceRef": null,
          "testRunId": 21784912,
          "testRunExecution": {
            "status": "pass",
            "passed": 3,
            "failed": 0,
            "skipped": 169,
            "collectionFailed": false,
            "testNamePattern": "renders loop:end only|renders continue-independent|renders a bounded exact-event|leaves a disarmed actionable AUTO|host discovery quota reset publication",
            "filePath": "packages/operator-core/lib/scheduler/fleet-scope-admission.test.ts",
            "passedCaseTitles": [],
            "testLayer": "unit",
            "passedCaseTitleCount": 3,
            "passedCaseTitlesOmitted": 3,
            "passedCaseTitlesRef": {
              "tool": "testing:runs",
              "args": {
                "testRunIds": [
                  21784912
                ],
                "cases": true
              }
            }
          },
          "testRunProvenance": {
            "filePath": "packages/operator-core/lib/scheduler/fleet-scope-admission.test.ts",
            "framework": "vitest",
            "source": "admin-ui",
            "mutationPhase": null,
            "commitSha": "1d63e8bf049543d7b49fdc700d5470203f949e53",
            "worktreeDirty": true
          },
          "details": {
            "scope": "Three named rendered-guidance cases only;169 sibling cases filtered. Committed source and test exactly equal original run commit. No scheduler runtime or whole-file acceptance.",
            "testRun": {
              "id": 21784912,
              "source": "admin-ui",
              "status": "pass",
              "filePath": "packages/operator-core/lib/scheduler/fleet-scope-admission.test.ts",
              "commitSha": "1d63e8bf049543d7b49fdc700d5470203f949e53",
              "finishedAt": "2026-10-22T21:10:39.149Z",
              "recordedRoot": "/home/marsh-office/papercupai-workspace/papercusp",
              "mutationPhase": null,
              "worktreeDirty": true,
              "recordedFilePath": "packages/operator-core/lib/scheduler/fleet-scope-admission.test.ts",
              "harnessAttribution": "run"
            },
            "adequacy": {
              "outcome": "passed",
              "skipped": false,
              "executed": true,
              "collected": true,
              "testLayer": "unit"
            },
            "measurementPin": {
              "files": [
                {
                  "path": "packages/operator-core/lib/scheduler/fleet-scope-admission.ts",
                  "repo": ".",
                  "clean": true,
                  "sha256": "7e5653d51dfd705a3b9a766198a4460a8d5dafa8af6228d2873c2baab6a27de1",
                  "headBlob": "94aa161adecb2612055a239d3589d0fc9a69dbd5",
                  "dimension": "source"
                },
                {
                  "path": "packages/operator-core/lib/scheduler/fleet-scope-admission.test.ts",
                  "repo": ".",
                  "clean": true,
                  "sha256": "01ea996376f9bf274b581707d0ef12cc3aa7cee613c789b06121486da6eab9aa",
                  "headBlob": "8609781dd8a8a63df2274b79e8b17b1922689a35",
                  "dimension": "test"
                }
              ],
              "repos": [
                {
                  "head": "d32eae0110551750ed8698297b5f8851e94fd4e0",
                  "repo": ".",
                  "gitlink": null
                }
              ],
              "schemaVersion": 1
            },
            "currentMeasurement": {
              "kind": "repo-files",
              "testPaths": [
                "packages/operator-core/lib/scheduler/fleet-scope-admission.test.ts"
              ],
              "sourcePaths": [
                "packages/operator-core/lib/scheduler/fleet-scope-admission.ts"
              ],
              "schemaVersion": 1
            }
          },
          "observedAt": "2026-10-22T22:31:47.675Z",
          "bindingFingerprint": "e0d4fd91360941ce084ec5759a191c9af8fcbd896d34286bc738acc11ec2fe40",
          "createdBy": "su-424d5476-0b13-401a-a926-0aaa9f212391",
          "createdAt": "2026-10-22T22:31:47.595Z",
          "serverMeasurement": {
            "status": "unavailable",
            "reason": "Cannot read properties of undefined (reading 'Latest')"
          },
          "currentness": {
            "overall": "unknown",
            "dimensions": {
              "spec": "current",
              "source": "unknown",
              "test": "unknown",
              "fixture": "not-applicable",
              "rubric": "not-applicable",
              "environment": "not-applicable",
              "coverageEvidence": "not-applicable",
              "testRun": "unknown"
            },
            "staleReasons": [],
            "unknownReasons": [
              "source-current-fingerprint-not-supplied",
              "test-current-fingerprint-not-supplied",
              "test-run-worktree-not-clean",
              "server-measurement-unavailable:Cannot read properties of undefined (reading 'Latest')"
            ],
            "comparisonSupplied": false,
            "provenance": "not-supplied"
          }
        },
        {
          "id": 65279,
          "workItemId": "WI-6554700010008887",
          "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
          "specId": "AUTO-BAR-R-32-P-008",
          "sourceValId": null,
          "specRevision": 1,
          "currentRevision": 1,
          "specFingerprint": "53994729feb67fccdbf6a2616898d415aa8e167ac1eb3cbbc0f100524e08cdd9",
          "evidenceKind": "test",
          "evidenceRef": "packages/operator-core/lib/scheduler/fleet-scope-admission.test.ts",
          "fingerprints": {
            "sourceFingerprint": "sha256-file-set-v1:aa907f78479eb8cc448732b37a1b035997902169f499f4c9d8941f27445c0ce8",
            "testFingerprint": "sha256-file-set-v1:997551f2d10917eeb4c8a6ce32c523a8ee07bf7f5e9635d3afa8bfe819a8b5c9",
            "fixtureFingerprint": null,
            "rubricFingerprint": null,
            "environmentFingerprint": null
          },
          "coverageEvidenceRef": null,
          "testRunId": 21784912,
          "testRunExecution": {
            "status": "pass",
            "passed": 3,
            "failed": 0,
            "skipped": 169,
            "collectionFailed": false,
            "testNamePattern": "renders loop:end only|renders continue-independent|renders a bounded exact-event|leaves a disarmed actionable AUTO|host discovery quota reset publication",
            "filePath": "packages/operator-core/lib/scheduler/fleet-scope-admission.test.ts",
            "passedCaseTitles": [],
            "testLayer": "unit",
            "passedCaseTitleCount": 3,
            "passedCaseTitlesOmitted": 3,
            "passedCaseTitlesRef": {
              "tool": "testing:runs",
              "args": {
                "testRunIds": [
                  21784912
                ],
                "cases": true
              }
            }
          },
          "testRunProvenance": {
            "filePath": "packages/operator-core/lib/scheduler/fleet-scope-admission.test.ts",
            "framework": "vitest",
            "source": "admin-ui",
            "mutationPhase": null,
            "commitSha": "1d63e8bf049543d7b49fdc700d5470203f949e53",
            "worktreeDirty": true
          },
          "details": {
            "scope": "Three named rendered-guidance cases only;169 sibling cases filtered. Committed source and test exactly equal original run commit. No scheduler runtime or whole-file acceptance.",
            "testRun": {
              "id": 21784912,
              "source": "admin-ui",
              "status": "pass",
              "filePath": "packages/operator-core/lib/scheduler/fleet-scope-admission.test.ts",
              "commitSha": "1d63e8bf049543d7b49fdc700d5470203f949e53",
              "finishedAt": "2026-10-22T21:10:39.149Z",
              "recordedRoot": "/home/marsh-office/papercupai-workspace/papercusp",
              "mutationPhase": null,
              "worktreeDirty": true,
              "recordedFilePath": "packages/operator-core/lib/scheduler/fleet-scope-admission.test.ts",
              "harnessAttribution": "run"
            },
            "adequacy": {
              "outcome": "passed",
              "skipped": false,
              "executed": true,
              "collected": true,
              "testLayer": "unit"
            },
            "measurementPin": {
              "files": [
                {
                  "path": "packages/operator-core/lib/scheduler/fleet-scope-admission.ts",
                  "repo": ".",
                  "clean": true,
                  "sha256": "7e5653d51dfd705a3b9a766198a4460a8d5dafa8af6228d2873c2baab6a27de1",
                  "headBlob": "94aa161adecb2612055a239d3589d0fc9a69dbd5",
                  "dimension": "source"
                },
                {
                  "path": "packages/operator-core/lib/scheduler/fleet-scope-admission.test.ts",
                  "repo": ".",
                  "clean": true,
                  "sha256": "01ea996376f9bf274b581707d0ef12cc3aa7cee613c789b06121486da6eab9aa",
                  "headBlob": "8609781dd8a8a63df2274b79e8b17b1922689a35",
                  "dimension": "test"
                }
              ],
              "repos": [
                {
                  "head": "d32eae0110551750ed8698297b5f8851e94fd4e0",
                  "repo": ".",
                  "gitlink": null
                }
              ],
              "schemaVersion": 1
            },
            "currentMeasurement": {
              "kind": "repo-files",
              "testPaths": [
                "packages/operator-core/lib/scheduler/fleet-scope-admission.test.ts"
              ],
              "sourcePaths": [
                "packages/operator-core/lib/scheduler/fleet-scope-admission.ts"
              ],
              "schemaVersion": 1
            }
          },
          "observedAt": "2026-10-22T22:31:47.444Z",
          "bindingFingerprint": "18592662005debc4b0e4fd3c4617a45cbc84d50b264fa2a0f5ed3a2542819cef",
          "createdBy": "su-424d5476-0b13-401a-a926-0aaa9f212391",
          "createdAt": "2026-10-22T22:31:47.400Z",
          "serverMeasurement": {
            "status": "unavailable",
            "reason": "Cannot read properties of undefined (reading 'Latest')"
          },
          "currentness": {
            "overall": "unknown",
            "dimensions": {
              "spec": "current",
              "source": "unknown",
              "test": "unknown",
              "fixture": "not-applicable",
              "rubric": "not-applicable",
              "environment": "not-applicable",
              "coverageEvidence": "not-applicable",
              "testRun": "unknown"
            },
            "staleReasons": [],
            "unknownReasons": [
              "source-current-fingerprint-not-supplied",
              "test-current-fingerprint-not-supplied",
              "test-run-worktree-not-clean",
              "server-measurement-unavailable:Cannot read properties of undefined (reading 'Latest')"
            ],
            "comparisonSupplied": false,
            "provenance": "not-supplied"
          }
        }
      ],
      "count": 13,
      "currentness": {
        "current": 0,
        "stale": 0,
        "unknown": 13
      }
    },
    "case-ledger": {
      "count": 2,
      "total": 2,
      "truncatedByLimit": false,
      "latestPerFile": false,
      "effectiveSourceFilter": "none (exact testRunIds receipt lookup)",
      "omittedBySourceFilter": 0,
      "runs": [
        {
          "id": 21784916,
          "workspaceId": "papercusp-workspace",
          "harnessSlug": "papercusp",
          "root": "/home/marsh-office/papercupai-workspace/papercusp",
          "executionDetails": {
            "root": "/home/marsh-office/papercupai-workspace/papercusp",
            "failed": 0,
            "passed": 5,
            "skipped": 16,
            "filePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
            "commitSha": "1d63e8bf049543d7b49fdc700d5470203f949e53",
            "testLayer": "unit",
            "runGroupId": "a6d513e9-c078-4370-8572-fde5353143a4",
            "harnessSlug": "papercusp",
            "workspaceId": "papercusp-workspace",
            "runStartedAt": "2026-10-22T21:11:02.902Z",
            "mutationPhase": null,
            "schemaVersion": 1,
            "worktreeDirty": true,
            "testNamePattern": "renders loop:end only|renders continue-independent|renders a bounded exact-event|leaves a disarmed actionable AUTO|host discovery quota reset publication",
            "collectionFailed": false,
            "passedCaseTitles": [
              "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['absolute local time']",
              "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['relative duration']",
              "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['ANSI and wrapped output']",
              "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['newest statement']",
              "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['no stated reset']"
            ],
            "worktreeDirtyReason": "145 porcelain line(s) before the run: M apps/operator-vite/src/components/adv/AdvWorkflowsTab.test.tsx |  M apps/operator/bin/bundle-host-common.sh |  M apps/operator/bin/runtime-worker-bundle-graph.test.ts |  M apps/operator/e2e/cloud-tutorial.spec.ts |  M apps/operator/lib/claude-dialog-pty.integration.test.ts",
            "runtimeEnvironmentAfterCaptureStatus": "not-configured",
            "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
          },
          "filePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
          "status": "pass",
          "framework": "vitest",
          "startedAt": "2026-10-22T21:11:06.996Z",
          "finishedAt": "2026-10-22T21:11:07.621Z",
          "durationMs": 625,
          "commitSha": "1d63e8bf049543d7b49fdc700d5470203f949e53",
          "runGroupId": "a6d513e9-c078-4370-8572-fde5353143a4",
          "source": "admin-ui",
          "branch": "staging",
          "outputTail": null,
          "loopLagP95Ms": 21.2,
          "rssMb": 217.6,
          "saturationSuspect": false,
          "worktreeDirty": true,
          "isScratchConfig": false,
          "cases": [
            {
              "caseKey": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['absolute local time']",
              "occurrence": 1,
              "status": "pass",
              "durationMs": 165,
              "errorTail": null
            },
            {
              "caseKey": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['relative duration']",
              "occurrence": 1,
              "status": "pass",
              "durationMs": 114,
              "errorTail": null
            },
            {
              "caseKey": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['ANSI and wrapped output']",
              "occurrence": 1,
              "status": "pass",
              "durationMs": 110,
              "errorTail": null
            },
            {
              "caseKey": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['newest statement']",
              "occurrence": 1,
              "status": "pass",
              "durationMs": 108,
              "errorTail": null
            },
            {
              "caseKey": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['no stated reset']",
              "occurrence": 1,
              "status": "pass",
              "durationMs": 108,
              "errorTail": null
            },
            {
              "caseKey": "provider detector replay mode follows the replacement child > quota ignores resumed history after a fresh launch, then detects a fresh failure",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "provider detector replay mode follows the replacement child > auth ignores resumed history after a fresh launch, then detects a fresh failure",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "parseQuotaResetAtMs (WI-6554700010008412) > parses the incident copy as a local-time instant",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "parseQuotaResetAtMs (WI-6554700010008412) > parses the clause after ANSI styling and terminal line wraps",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "parseQuotaResetAtMs (WI-6554700010008412) > parses a relative duration from the moment it is read",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "parseQuotaResetAtMs (WI-6554700010008412) > reads a bare time already past as tomorrow, and a yearless past date as next year",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "parseQuotaResetAtMs (WI-6554700010008412) > uses the newest statement when the window holds an older wall too",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "parseQuotaResetAtMs (WI-6554700010008412) > never returns a reset that is not in the future, and never parses other products",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > holds the incident latch until the stated reset, then expires it once",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > re-latches with the new reset when the wall is still up on the next turn",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > picks up a reset clause that arrives in a later chunk than the matched words",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > keeps the fail-closed level when no reset is stated and probing is off (control)",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > probes a latched codex wall before its stated reset, backing off while it stays walled",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > starts a new episode at the base interval once a wall returns long after the last probe",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > never probes a claude wall (its TUI auto-continues at the reset)",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > clears the parsed reset on recycle",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            }
          ]
        },
        {
          "id": 21784912,
          "workspaceId": "papercusp-workspace",
          "harnessSlug": "papercusp",
          "root": "/home/marsh-office/papercupai-workspace/papercusp",
          "executionDetails": {
            "root": "/home/marsh-office/papercupai-workspace/papercusp",
            "failed": 0,
            "passed": 3,
            "skipped": 169,
            "filePath": "packages/operator-core/lib/scheduler/fleet-scope-admission.test.ts",
            "commitSha": "1d63e8bf049543d7b49fdc700d5470203f949e53",
            "testLayer": "unit",
            "runGroupId": "a6d513e9-c078-4370-8572-fde5353143a4",
            "harnessSlug": "papercusp",
            "workspaceId": "papercusp-workspace",
            "runStartedAt": "2026-10-22T21:09:57.885Z",
            "mutationPhase": null,
            "schemaVersion": 1,
            "worktreeDirty": true,
            "testNamePattern": "renders loop:end only|renders continue-independent|renders a bounded exact-event|leaves a disarmed actionable AUTO|host discovery quota reset publication",
            "collectionFailed": false,
            "passedCaseTitles": [
              "fleet scope assignment admission (P-016) > EI-18663622382734446: a spec matching ZERO rows is named loudly, never folded into a bare drain > renders loop:end only for legitimate completion or stop when unfinished obligations are retained",
              "fleet scope assignment admission (P-016) > EI-18663622382734446: a spec matching ZERO rows is named loudly, never folded into a bare drain > renders continue-independent-work guidance for a partially blocked agent",
              "fleet scope assignment admission (P-016) > EI-18663622382734446: a spec matching ZERO rows is named loudly, never folded into a bare drain > renders a bounded exact-event wake with timeout for a fully blocked agent"
            ],
            "worktreeDirtyReason": "142 porcelain line(s) before the run: M apps/operator-vite/src/components/adv/AdvWorkflowsTab.test.tsx |  M apps/operator/bin/bundle-host-common.sh |  M apps/operator/bin/runtime-worker-bundle-graph.test.ts |  M apps/operator/e2e/cloud-tutorial.spec.ts |  M apps/operator/lib/claude-dialog-pty.integration.test.ts",
            "runtimeEnvironmentAfterCaptureStatus": "not-configured",
            "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
          },
          "filePath": "packages/operator-core/lib/scheduler/fleet-scope-admission.test.ts",
          "status": "pass",
          "framework": "vitest",
          "startedAt": "2026-10-22T21:10:39.126Z",
          "finishedAt": "2026-10-22T21:10:39.149Z",
          "durationMs": 23,
          "commitSha": "1d63e8bf049543d7b49fdc700d5470203f949e53",
          "runGroupId": "a6d513e9-c078-4370-8572-fde5353143a4",
          "source": "admin-ui",
          "branch": "staging",
          "outputTail": null,
          "loopLagP95Ms": null,
          "rssMb": 674.7,
          "saturationSuspect": null,
          "worktreeDirty": true,
          "isScratchConfig": false,
          "cases": [
            {
              "caseKey": "fleetLeaderUnavailableRefusal (EI-21079515303301272) > is a recoverable pre-claim block, not a drained-lane verdict",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "WI-41163: caller-neutral feature-family population count > explicit null omits the reading leader from the feature-family cooldown floor",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "WI-41163: caller-neutral feature-family population count > names additional excluding floors from the same feature claim predicate registry",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "WI-41163: caller-neutral feature-family population count > returns matched, claimable, and overlapping reservation-floor counts",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "WI-41163: caller-neutral feature-family population count > passes the scope fleet and structural fleet authorization to the shared floor",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "WI-41163: caller-neutral feature-family population count > EI-21398324268952860: derives structural GOAL authorization for both floors, and withholds it for a spec that does not reference goal",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > evaluates the full boolean grammar, including id cohort + non-P2P exclusion",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > treats an unknown not-yet-minted id as outside a fixed cohort",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > mirrors priority inversion and array membership semantics from the SQL compiler",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > hydrates issue plan/risk/path vocabulary from the canonical payload shape",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > returns an explicit wind-down verdict instead of generic-backlog advice",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-21659493450381888: loop admission refuses a per-cup scheduler-spec mismatch even without fleet membership",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > releases every incompatible pre-existing claim in one reconciliation sweep and alerts once",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-16710: a feature-family item matches scope using the caller-supplied workspaceId, not an ambient global",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-12832: fleet pause gates the claim/assign admission path > refuses a member by-id claim while its fleet is winding-down (paused), before any item read",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-12832: fleet pause gates the claim/assign admission path > fails closed when membership authority cannot be read",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-12832: fleet pause gates the claim/assign admission path > fails closed when stable-target authority cannot be read",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-12832: fleet pause gates the claim/assign admission path > fails closed when pause authority cannot be read",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-12832: fleet pause gates the claim/assign admission path > allows the SAME in-spec claim once the fleet is active again (the fix is control-state-conditional)",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-12832: fleet pause gates the claim/assign admission path > fleetScopedMiss surfaces a paused stand-down verdict for the self-select path",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-12832: fleet pause gates the claim/assign admission path > EI-15777: a paused miss surfaces claimableAwaitsCancelled + the do-not-re-park advice",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-12832: fleet pause gates the claim/assign admission path > EI-15777: a paused miss with no cancelled awaits still surfaces claimableAwaitsCancelled:0 (default)",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-12832: fleet pause gates the claim/assign admission path > EI-15777: a non-paused (cooldown-only) miss never carries claimableAwaitsCancelled",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-12832: fleet pause gates the claim/assign admission path > readFleetPauseState preserves UNKNOWN when the control-state read errors",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-13520: cooldown-only miss re-attribution > returns the cooldown-excluded count + earliest expiry + the argmin row id when rows match sans the cooldown floor",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-13520: cooldown-only miss re-attribution > returns null (no diagnosis) when nothing matches even without the cooldown floor",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-13520: cooldown-only miss re-attribution > returns null when the spec has no view filter (nothing to diagnose)",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-13520: cooldown-only miss re-attribution > FAILS SOFT: a query error degrades to null, never throws (annotation only, like buildMissDiagnosis)",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-13520: cooldown-only miss re-attribution > fleetScopedMiss reattributes a cooldown-only miss: honest message, cooldownOnly flag, do-not-re-author advice",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-13520: cooldown-only miss re-attribution > EI-14615/EI-16519: absolute cooldown expiry + argmin row id + churn-vs-livelock advice > surfaces cooldownExpiryAt as the ISO of earliestExpiryMs (so a re-stamped window is observable across polls)",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-13520: cooldown-only miss re-attribution > EI-14615/EI-16519: absolute cooldown expiry + argmin row id + churn-vs-livelock advice > surfaces cooldownEarliestRowId and teaches the SAME-id-vs-different-id distinction (EI-16519)",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-13520: cooldown-only miss re-attribution > EI-14615/EI-16519: absolute cooldown expiry + argmin row id + churn-vs-livelock advice > cooldownExpiryAt is null-safe when earliestExpiryMs is null (defensive; WI-5303 makes it non-null in practice)",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-13520: cooldown-only miss re-attribution > EI-14615/EI-16519: absolute cooldown expiry + argmin row id + churn-vs-livelock advice > a paused miss carries NO cooldownExpiryAt even if a cooldownDiag is passed (pause fully explains the miss)",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-13520: cooldown-only miss re-attribution > fleetScopedMiss keeps the ORIGINAL scope-mismatch message when cooldownDiag is null/absent (no false reattribution)",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-13520: cooldown-only miss re-attribution > a paused miss NEVER reattributes to cooldown, even if a cooldownDiag is passed (pause explains the miss fully)",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > WI-5561: issue-family floor-breakdown miss re-attribution > returns the floor breakdown when the spec matches issue-family rows, threading harness/assignee/states/rigAvailable",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > WI-5561: issue-family floor-breakdown miss re-attribution > fits acquire + statement + helper overhead inside a tighter caller budget",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > WI-5561: issue-family floor-breakdown miss re-attribution > falls back to the spec's own `states` when no explicit states are passed",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > WI-5561: issue-family floor-breakdown miss re-attribution > EI-18663622382734446: returns the breakdown (NOT null) when the filter matches zero issue-family rows — the spec-empty case must be distinguishable from a diagnosis failure",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > WI-5561: issue-family floor-breakdown miss re-attribution > FAILS SOFT: a query error degrades to null, never throws (annotation only, like diagnoseFleetScopeCooldownMiss)",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > WI-5561: issue-family floor-breakdown miss re-attribution > FAILS SOFT: a bounded transaction acquisition/timeout error degrades to null",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > WI-5561: issue-family floor-breakdown miss re-attribution > skips the DB entirely when the caller cannot fund both 100ms legs plus helper overhead",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > WI-5561: issue-family floor-breakdown miss re-attribution > returns null when the workspace cannot be resolved (nothing to diagnose)",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > WI-5561: issue-family floor-breakdown miss re-attribution > fleetScopedMiss surfaces excludedBreakdown + excludedBreakdownSummary + floor-gated advice when an issueBreakdown is present",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > WI-5561: issue-family floor-breakdown miss re-attribution > fleetScopedMiss routes a member to peer review instead of standing down when spec rows await review",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > WI-5561: issue-family floor-breakdown miss re-attribution > fleetScopedMiss still certifies the floor-gated drain when nothing awaits review (revision-requested alone is not reviewable)",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > WI-5561: issue-family floor-breakdown miss re-attribution > fleetScopedMiss never offers review to a PAUSED fleet member",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > WI-5561: issue-family floor-breakdown miss re-attribution > EI-18741523426513509: sets reason `all_matches_gated` (NOT spec_matches_nothing) when the spec matched real rows but every one is floor-excluded",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > WI-5561: issue-family floor-breakdown miss re-attribution > EI-18741523426513509 recurrence guard: an uncleared plan-lane externalBlocker gate (the live 2026-07-26 repro) returns `all_matches_gated`, never `spec_matches_nothing`",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > WI-5561: issue-family floor-breakdown miss re-attribution > fleetScopedMiss keeps the ORIGINAL scope-mismatch message + omits excludedBreakdown when issueBreakdown is null/absent",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > WI-5561: issue-family floor-breakdown miss re-attribution > a paused miss NEVER surfaces the floor breakdown, even if an issueBreakdown is passed (pause explains the miss fully)",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > WI-5561: issue-family floor-breakdown miss re-attribution > a cooldown-only miss and a floor breakdown can co-occur (both are independent, non-paused annotations)",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > WI-7316: a lane held shut by a STALE plan-item block is never certified as a drain > refuses windDown and names the rows + the one-call remedy",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > WI-7316: a lane held shut by a STALE plan-item block is never certified as a drain > is inert when no row carried a stale hint — an ordinary drain still certifies",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > WI-7316: a lane held shut by a STALE plan-item block is never certified as a drain > a PAUSED fleet still reports the pause, not the stale block",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-18663622382734446: a spec matching ZERO rows is named loudly, never folded into a bare drain > sets a distinct top-level reason + loud error + escalate advice, but still windDown:true (correct to stop pulling)",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-18663622382734446: a spec matching ZERO rows is named loudly, never folded into a bare drain > EI-20186990913643457: reports successful exhaustion when every status-floor-free match is terminal",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-18663622382734446: a spec matching ZERO rows is named loudly, never folded into a bare drain > P-008: completed plan checks retained obligations before winding down",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-18663622382734446: a spec matching ZERO rows is named loudly, never folded into a bare drain > P-008: exhausted spec checks retained obligations before winding down",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-18663622382734446: a spec matching ZERO rows is named loudly, never folded into a bare drain > P-008: held remainder checks retained obligations before winding down",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-18663622382734446: a spec matching ZERO rows is named loudly, never folded into a bare drain > P-008: ordinary feature drain checks retained obligations before winding down",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-18663622382734446: a spec matching ZERO rows is named loudly, never folded into a bare drain > P-008: empty spec with live leader checks retained obligations before winding down",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-18663622382734446: a spec matching ZERO rows is named loudly, never folded into a bare drain > P-008: empty spec with dead leader checks retained obligations before winding down",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-18663622382734446: a spec matching ZERO rows is named loudly, never folded into a bare drain > P-008: floor-gated spec checks retained obligations before winding down",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-18663622382734446: a spec matching ZERO rows is named loudly, never folded into a bare drain > P-008: filtered idle watch checks retained obligations before winding down",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-18663622382734446: a spec matching ZERO rows is named loudly, never folded into a bare drain > P-008: unfilterable idle scope checks retained obligations before winding down",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-18663622382734446: a spec matching ZERO rows is named loudly, never folded into a bare drain > renders loop:end only for legitimate completion or stop when unfinished obligations are retained",
              "occurrence": 1,
              "status": "pass",
              "durationMs": 7,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-18663622382734446: a spec matching ZERO rows is named loudly, never folded into a bare drain > renders continue-independent-work guidance for a partially blocked agent",
              "occurrence": 1,
              "status": "pass",
              "durationMs": 1,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-18663622382734446: a spec matching ZERO rows is named loudly, never folded into a bare drain > renders a bounded exact-event wake with timeout for a fully blocked agent",
              "occurrence": 1,
              "status": "pass",
              "durationMs": 1,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-18663622382734446: a spec matching ZERO rows is named loudly, never folded into a bare drain > EI-20260781488788952: reports a completed bound plan as a successful plan wind-down",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-18663622382734446: a spec matching ZERO rows is named loudly, never folded into a bare drain > EI-22179902813950215: a plan-complete verdict survives a degraded (null) issue-floor breakdown",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-18663622382734446: a spec matching ZERO rows is named loudly, never folded into a bare drain > EI-22179902813950215: a successfully-read nonzero issue-floor breakdown still overrides plan terminality",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-18663622382734446: a spec matching ZERO rows is named loudly, never folded into a bare drain > EI-20260781488788952: a dead leader changes the zero-match handoff without changing the spec verdict",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-18663622382734446: a spec matching ZERO rows is named loudly, never folded into a bare drain > keeps the spec-authoring verdict when the status-floor-free matches are mixed terminal and active",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-18663622382734446: a spec matching ZERO rows is named loudly, never folded into a bare drain > WI-6554700010010002: a remainder held by agents or parked is not an empty spec > reports spec_in_flight with drain advice when the only non-terminal match is held by an agent",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-18663622382734446: a spec matching ZERO rows is named loudly, never folded into a bare drain > WI-6554700010010002: a remainder held by agents or parked is not an empty spec > reports spec_in_flight when the non-terminal remainder is parked (blocked/needs-human) or wholly held",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-18663622382734446: a spec matching ZERO rows is named loudly, never folded into a bare drain > WI-6554700010010002: a remainder held by agents or parked is not an empty spec > does not certify the remainder without a measured zero breakdown, or while paused",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-18663622382734446: a spec matching ZERO rows is named loudly, never folded into a bare drain > WI-6554700010010002: a remainder held by agents or parked is not an empty spec > keeps spec_exhausted for an all-terminal tranche",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-18663622382734446: a spec matching ZERO rows is named loudly, never folded into a bare drain > is mutually exclusive with the divergent (claim-path bug) case by construction",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-18663622382734446: a spec matching ZERO rows is named loudly, never folded into a bare drain > a paused miss suppresses specEmpty just like every other breakdown-derived signal",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-18663622382734446: a spec matching ZERO rows is named loudly, never folded into a bare drain > cooldown never masks specEmpty — a truly empty spec takes precedence in the error/advice",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > WI-7151: featureFamilyMatched suppresses a false specEmpty (issue-family diagnosis blind spot) > EI-24905216534076710: pre-floor feature matches survive miss diagnosis > reports a held feature as floor-gated without widening its non-plan spec",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > WI-7151: featureFamilyMatched suppresses a false specEmpty (issue-family diagnosis blind spot) > EI-24905216534076710: pre-floor feature matches survive miss diagnosis > combines disjoint families while preserving overlapping exclusion buckets",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > WI-7151: featureFamilyMatched suppresses a false specEmpty (issue-family diagnosis blind spot) > EI-24905216534076710: pre-floor feature matches survive miss diagnosis > keeps a claimable feature as a blind spot, with no stand-down",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > WI-7151: featureFamilyMatched suppresses a false specEmpty (issue-family diagnosis blind spot) > EI-24905216534076710: pre-floor feature matches survive miss diagnosis > retains a genuine zero-match authoring verdict when both measured families are empty",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > WI-7151: featureFamilyMatched suppresses a false specEmpty (issue-family diagnosis blind spot) > EI-24905216534076710: pre-floor feature matches survive miss diagnosis > keeps the pause verdict ahead of measured feature floors",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > WI-7151: featureFamilyMatched suppresses a false specEmpty (issue-family diagnosis blind spot) > suppresses specEmpty/spec_matches_nothing when a tier-1 (feature-family) match exists",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > WI-7151: featureFamilyMatched suppresses a false specEmpty (issue-family diagnosis blind spot) > reports ordinary_drain when both measured families are empty",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > WI-7151: featureFamilyMatched suppresses a false specEmpty (issue-family diagnosis blind spot) > keeps plan-scoped family evidence unknown when only a missing or zero survivor count is available",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > WI-7151: featureFamilyMatched suppresses a false specEmpty (issue-family diagnosis blind spot) > a paused miss suppresses the feature-family verdict too, same as every other breakdown-derived signal",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > WI-7151: featureFamilyMatched suppresses a false specEmpty (issue-family diagnosis blind spot) > a paused miss suppresses `ordinary_drain` too, same as every other breakdown-derived signal",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > WI-7151: featureFamilyMatched suppresses a false specEmpty (issue-family diagnosis blind spot) > has no effect on a non-zero issueBreakdown.matchedByFilter (only relevant to the matchedByFilter===0 case)",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-19393442073558754: plan-predicate scoping edge cases > detects a plan predicate NESTED inside an `all` (not just a bare top-level leaf)",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-19393442073558754: plan-predicate scoping edge cases > detects `plan_item` (not just `plan`) as the family-correlated field",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-19393442073558754: plan-predicate scoping edge cases > an explicit issue-family kind restriction on a plan-scoped spec overrides back to spec_matches_nothing",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-19393442073558754: plan-predicate scoping edge cases > an id-only filter cannot certify an empty spec when feature diagnosis is unavailable",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-19393442073558754: plan-predicate scoping edge cases > an id-only filter retains a genuine empty-spec verdict when both families were measured empty",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-18666093519248020: claimable > 0 is a DIVERGENCE, never a drain > does NOT set windDown when the oracle still reports claimable rows (the harmful half)",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-18666093519248020: claimable > 0 is a DIVERGENCE, never a drain > names the divergence in `error` instead of claiming the scope matched nothing",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-18666093519248020: claimable > 0 is a DIVERGENCE, never a drain > advice tells the member to keep working (claim by id) and to report a claim-path bug — never to stand down",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-18666093519248020: claimable > 0 is a DIVERGENCE, never a drain > WI-5947: the report instruction is framed as an observation to re-verify, not a settled diagnosis",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-18666093519248020: claimable > 0 is a DIVERGENCE, never a drain > WI-5947: warns that the by-id workaround can itself return an empty list under churn",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-18666093519248020: claimable > 0 is a DIVERGENCE, never a drain > the breakdown summary says the pool is NOT floor-gated, so the floor counts are not misread as the cause",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-18666093519248020: claimable > 0 is a DIVERGENCE, never a drain > a divergence outranks a cooldown re-attribution (never renders as do-not-escalate cooldown noise)",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-18666093519248020: claimable > 0 is a DIVERGENCE, never a drain > WI-5947 — survivors reported but NOT confirmed by a second claim attempt > does not pronounce a divergence, and does not tell anyone to file a claim-path bug",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-18666093519248020: claimable > 0 is a DIVERGENCE, never a drain > WI-5947 — survivors reported but NOT confirmed by a second claim attempt > still refuses to certify a drain — an unconfirmed reading is not evidence of an empty lane",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-18666093519248020: claimable > 0 is a DIVERGENCE, never a drain > WI-5947 — survivors reported but NOT confirmed by a second claim attempt > names the real likely cause (the pool moved) and gives the one useful action: pull again",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-18666093519248020: claimable > 0 is a DIVERGENCE, never a drain > WI-5947 — survivors reported but NOT confirmed by a second claim attempt > stamps the provenance so a relayed report carries its own confidence level",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-18666093519248020: claimable > 0 is a DIVERGENCE, never a drain > WI-5947 — survivors reported but NOT confirmed by a second claim attempt > the breakdown summary frames the survivors as a later instant, not a floor story",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-18666093519248020: claimable > 0 is a DIVERGENCE, never a drain > claimable === 0 keeps the existing floor-gated verdict verbatim (windDown + stand-down advice)",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-18666093519248020: claimable > 0 is a DIVERGENCE, never a drain > a PAUSED fleet still stands down even though a divergent breakdown was passed (pause is a real stand-down)",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-18666093519248020: claimable > 0 is a DIVERGENCE, never a drain > a miss with NO breakdown at all is unchanged (windDown, original message)",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-18221674485894260: fleet-scope refusal names the one-call widen action > EI-20263410682554156: identifies a terminal plan pin and changes the remedy from per-row widening to re-steering",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-18221674485894260: fleet-scope refusal names the one-call widen action > fleetScopeLeaderRemedy names scheduler:set_claim_spec, the fleet slug, and the current spec ref (unambiguous, not \"@N\") for a scope violation",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-18221674485894260: fleet-scope refusal names the one-call widen action > states that completing a stamped work-item can reflect its plan item to done",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-18221674485894260: fleet-scope refusal names the one-call widen action > fleetScopeLeaderRemedy routes a fleet_winding_down refusal at fleet:resume, NOT a spec widen",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-18221674485894260: fleet-scope refusal names the one-call widen action > fleetScopeLeaderRemedy still names the widen tool for a fleet_scope_missing (no authored spec) refusal",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-18221674485894260: fleet-scope refusal names the one-call widen action > a fleet_scope_missing receipt includes the append-ids call for the refused id",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-18221674485894260: fleet-scope refusal names the one-call widen action > the fleet leader auto-message includes the append-ids call for the refused id",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-18221674485894260: fleet-scope refusal names the one-call widen action > notifyFleetScopeRefusal sends the leader a body carrying the factual reason AND the concrete widen action",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-18221674485894260: fleet-scope refusal names the one-call widen action > returns and stamps a typed dependency escape when the refused row blocks member-held work",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > WI-6326: the \"route elsewhere\" exit is code-conditional on a real presence read > hasLiveFleetRouteTarget > reports false when every OTHER row in the fleet is present-but-not-alive or absent",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > WI-6326: the \"route elsewhere\" exit is code-conditional on a real presence read > hasLiveFleetRouteTarget > reports true when another member/leader in the fleet is present and alive",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > WI-6326: the \"route elsewhere\" exit is code-conditional on a real presence read > hasLiveFleetRouteTarget > ignores rows from a DIFFERENT fleet",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > WI-6326: the \"route elsewhere\" exit is code-conditional on a real presence read > hasLiveFleetRouteTarget > degrades to null (unknown) on a lookup failure rather than a false negative",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > WI-6326: the \"route elsewhere\" exit is code-conditional on a real presence read > fleetScopeLeaderRemedy liveRouteTarget wiring > keeps the original unconditional wording when a live target exists",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > WI-6326: the \"route elsewhere\" exit is code-conditional on a real presence read > fleetScopeLeaderRemedy liveRouteTarget wiring > keeps the original unconditional wording when liveness is UNKNOWN (null/undefined) — never asserts a false negative",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > WI-6326: the \"route elsewhere\" exit is code-conditional on a real presence read > fleetScopeLeaderRemedy liveRouteTarget wiring > replaces the \"route elsewhere\" exit with an honest closed-exit statement + the ledger fallback when no live target exists",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > WI-6326: the \"route elsewhere\" exit is code-conditional on a real presence read > fleetScopeLeaderRemedy liveRouteTarget wiring > never applies the liveness note to a fleet_winding_down refusal (that branch never mentions \"route elsewhere\")",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > WI-6326: the \"route elsewhere\" exit is code-conditional on a real presence read > notifyFleetScopeRefusal returns the liveRouteTarget verdict AND reflects it in the leader message body",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > WI-6326: the \"route elsewhere\" exit is code-conditional on a real presence read > notifyFleetScopeRefusal skips the liveness lookup entirely for a fleet_winding_down refusal",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-18674160393981819: payloadFilter is scoped to the caller's own harness > ANDs the caller harness into a spec-derived payloadFilter (kind-only spec, the real nonp2p-bug-drain shape)",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-18674160393981819: payloadFilter is scoped to the caller's own harness > labels payloadFilter as a candidate hint, not an exact admission guarantee",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-18674160393981819: payloadFilter is scoped to the caller's own harness > falls back to a harness-only filter when the spec narrows on nothing payload-filterable",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-18674160393981819: payloadFilter is scoped to the caller's own harness > omits payloadFilter entirely when no harness is known AND the spec narrows on nothing payload-filterable (no unsound narrowing)",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "fleet scope assignment admission (P-016) > EI-18674160393981819: payloadFilter is scoped to the caller's own harness > a cross-harness claimable event never matches the derived filter (the actual regression: an oddsmith-hive bug woke a papercusp fleet)",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "itemMatchesRawClaimSpec (EI-18862608742257943 — pre-launch kickoff-vs-spec check) > matches an issue-family item purely (no SQL call) when its kind is in-spec",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "itemMatchesRawClaimSpec (EI-18862608742257943 — pre-launch kickoff-vs-spec check) > does NOT match an issue-family item whose kind is outside the spec (the exact live repro shape)",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "itemMatchesRawClaimSpec (EI-18862608742257943 — pre-launch kickoff-vs-spec check) > routes a feature-family item through the SQL EXISTS check, keyed on the passed workspaceId",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "self-filed fallout admission (EI-18732199386440540) > the reported repro: a bug this member filed itself, out of spec",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "self-filed fallout admission (EI-18732199386440540) > NEGATIVE CONTROL — a bug filed by a PEER is still refused (this is not a general widening)",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "self-filed fallout admission (EI-18732199386440540) > NEGATIVE CONTROL — a self-filed `change` is refused: you may absorb what you broke, not self-authorize new work",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "self-filed fallout admission (EI-18732199386440540) > NEGATIVE CONTROL — a self-filed `task` is refused for the same reason",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "self-filed fallout admission (EI-18732199386440540) > a row with no createdBy (feature-family, legacy) can never match — no null-equals-null admission",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "self-filed fallout admission (EI-18732199386440540) > admits the self-filed fallout bug through the real admission seam, not just the predicate",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "self-filed fallout admission (EI-18732199386440540) > keeps atomic create+assign atomic for a server-attributed self-filed bug",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "self-filed fallout admission (EI-18732199386440540) > admits a by-id self-filed bug even when the fleet has no authored claim spec",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "self-filed fallout admission (EI-18732199386440540) > keeps atomic create+assign atomic for a self-filed bug when the fleet has no authored claim spec",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "self-filed fallout admission (EI-18732199386440540) > keeps atomic no-spec peer bugs refused instead of widening the self-filed exception",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "self-filed fallout admission (EI-18732199386440540) > keeps atomic no-spec self-filed non-bugs refused instead of widening by provenance alone",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "self-filed fallout admission (EI-18732199386440540) > admits a by-id claim for an item durably dispatched by the current fleet leader",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "self-filed fallout admission (EI-18732199386440540) > refuses a by-id claim whose assignedBy is not the current fleet leader",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "self-filed fallout admission (EI-18732199386440540) > keeps atomic create+assign atomic for a server-attributed leader dispatch",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "self-filed fallout admission (EI-18732199386440540) > does not turn the atomic seam into a peer-assignment escape hatch",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "self-filed fallout admission (EI-18732199386440540) > does not let atomic self-filing bypass a winding-down fleet",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "self-filed fallout admission (EI-18732199386440540) > ORDERING CONTROL — a winding-down fleet still refuses the self-filed bug (EI-12832 keeps precedence)",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "self-filed fallout admission (EI-18732199386440540) > keeps no-spec peer bugs refused instead of widening the lane beyond self-filed fallout",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "self-filed fallout admission (EI-18732199386440540) > a refused self-filed non-bug is TOLD why the carve-out did not apply, instead of a bare spec mismatch",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "self-filed fallout admission (EI-18732199386440540) > the reconciliation sweep KEEPS a self-filed fallout claim instead of quarantining it back",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "self-filed fallout admission (EI-18732199386440540) > the reconciliation sweep KEEPS a current-leader-dispatched claim instead of quarantining it back",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "self-filed fallout admission (EI-18732199386440540) > leaderDispatchedAdmission fails closed when the durable leader is unavailable",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "self-filed fallout admission (EI-18732199386440540) > EI-20426366154081065: the self-filed kind refusal stops advertising the re-file bypass > never instructs the member to re-file the work as a bug",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "self-filed fallout admission (EI-18732199386440540) > EI-20426366154081065: the self-filed kind refusal stops advertising the re-file bypass > warns AGAINST the re-file and says why the carve-out is not a relabel",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "self-filed fallout admission (EI-18732199386440540) > EI-20426366154081065: the self-filed kind refusal stops advertising the re-file bypass > still names the kind that was refused and the kind the carve-out admits",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "self-filed fallout admission (EI-18732199386440540) > EI-20426366154081065: the self-filed kind refusal stops advertising the re-file bypass > names the two containment-preserving routes (widen the lane / work it unheld)",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "self-filed fallout admission (EI-18732199386440540) > EI-20426366154081065: the self-filed kind refusal stops advertising the re-file bypass > is silent when it does not apply — a peer-filed row, and a self-filed bug (already admitted)",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "self-filed fallout admission (EI-18732199386440540) > EI-20426366154081065: the self-filed kind refusal stops advertising the re-file bypass > the real refusal path carries the hint — the seam is wired, not just the helper",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "self-filed fallout admission (EI-18732199386440540) > EI-20426366154081065: the self-filed kind refusal stops advertising the re-file bypass > CONTROL: these assertions reject the pre-fix wording (they are not vacuous)",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "self-filed fallout admission (EI-18732199386440540) > CONTROL: the case table rejects both an always-admit and a never-admit implementation",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "WI-10005683: fleet-scope admission's own widen recommendation passes its own write door > fencePreservingWidenFilter output is NOT refused for a goal-fenced incumbent lane",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "WI-10005683: fleet-scope admission's own widen recommendation passes its own write door > CALIBRATION: the composition is discriminating — a hand-rolled class widen is still refused",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            },
            {
              "caseKey": "WI-10005683: fleet-scope admission's own widen recommendation passes its own write door > the no-incumbent-filter branch still yields a bare id leaf, which needs no fence carve-out",
              "occurrence": 1,
              "status": "skip",
              "durationMs": null,
              "errorTail": null
            }
          ]
        }
      ]
    },
    "command-sample": {
      "ok": true,
      "summary": {
        "bash_id": "0b6e6606-b3f",
        "task_id": "0mvk5m641hvt3xc16uy",
        "status": "completed",
        "exit_code": 0,
        "output": "{\"at\": 1792710619.7504892, \"scope\": \"exact sidecar3309229 subtree and bg3289667 five-minute papercusp Git messages\", \"processes\": [{\"pid\": 3309229, \"ppid\": 3305587, \"state\": \"R\", \"exe\": \"node\", \"cwd\": \"/home/marsh-office/papercupai-workspace/papercusp/apps/operator\", \"children\": [3318570], \"gitArgs\": null}, {\"pid\": 3318570, \"ppid\": 3309229, \"state\": \"S\", \"exe\": \"node\", \"cwd\": \"/home/marsh-office/papercupai-workspace/papercusp/apps/operator\", \"children\": [2643730], \"gitArgs\": null}, {\"pid\": 2643730, \"ppid\": 3318570, \"state\": \"R\", \"exe\": \"git\", \"cwd\": \"/home/marsh-office/.papercusp-workspaces/clones/papercusp-pr-drill-20261014\", \"children\": [], \"gitArgs\": [\"\"]}], \"subtreeTruncated\": false, \"journalExit\": 0, \"selectedMessages\": [{\"at\": \"1792710526074414\", \"message\": \"[git-sync] papercusp-pr-drill-20261014-2/libs/papercusp: merge conflict (packages/orchestrator/src/blueprint/mode-catalog.generated.ts) \\u2014 aborted clean, continuing (papercusp-pr-drill-20261014-2)\"}, {\"at\": \"1792710566334749\", \"message\": \"[git-sync] papercusp/libs/generic/chat-protocol: own-head published main@492fbc2467f4 into own namespace\"}, {\"at\": \"1792710569599117\", \"message\": \"[git-sync] papercusp: hive git mode 'bridged' \\u2014 commit-only this tick (the bridge owns origin pushes)\"}, {\"at\": \"1792710592119475\", \"message\": \"[git-sync] papercusp: an in-flight git-sync auto-commit holds git-sync:papercusp \\u2014 skipping this tick\"}]}\n",
        "log_path": "/home/marsh-office/papercupai-workspace/papercusp/.papercusp/scratch/bash-0b6e6606-b3f.log"
      },
      "logs": [],
      "dryRun": false,
      "dispatchCount": 1,
      "dispatchTimings": {
        "calls": [
          {
            "ordinal": 0,
            "tool": "capability:bash",
            "effect": "write",
            "elapsedMs": 2063,
            "disposition": "settled",
            "callId": "eew5qo-537"
          }
        ],
        "totalCount": 1,
        "omittedCount": 0,
        "maxCalls": 24
      },
      "intermediateBytes": 2242,
      "runtimeObservations": {
        "authorizationObservationCount": 1,
        "authorityWideningDetected": false,
        "midTurnPromptInjectionObservability": "not-observable"
      },
      "childFailures": [],
      "partial": false,
      "mutations": {
        "count": 1,
        "byTool": {
          "capability:bash": 1
        },
        "attemptedCount": 1,
        "settledPrefixCount": 1,
        "dispositions": {
          "settled": [
            0
          ]
        },
        "note": "count includes only write calls that settled successfully before code:run returned; disposition indexes are zero-based dispatch order and in_flight calls require verification before retry"
      }
    },
    "c0reply": {
      "owner_id": "su-424d5476-0b13-401a-a926-0aaa9f212391",
      "summary": {
        "total": 1,
        "returned": 1,
        "truncated": 0,
        "ambient_excluded": 1507,
        "intent_excluded": 0,
        "coalesced_dupes": 0,
        "from_resolved": "su-c0f4f0de-73ad-464d-a13a-e5d96297bcb6",
        "from_unmatched": false,
        "by_kind": {
          "message": 1
        },
        "oldest_returned_ts": "2026-10-22T23:14:44.797Z",
        "newest_ts": "2026-10-22T23:14:44.797Z"
      },
      "entries": [
        {
          "to": [
            "su-424d5476-0b13-401a-a926-0aaa9f212391"
          ],
          "ts": "2026-10-22T23:14:44.797Z",
          "why": {
            "goalRef": "WI-6554700010020921"
          },
          "body": "I have no verified command correlation beyond the retained routine last_error (7200000ms) and old loaded source060876c3b0. WI-10006526 checkpoint43746c029525 explicitly corrects attribution: old withGitSyncPhase overwrote activePhase without restoring it; canonical12c415afc1 already uses activePhases Map/delete. Do not join your205545ms request to that timeout on this evidence. New instrumentation should identify the actual active interval/command; no duplicate phase fix is needed.",
          "from": "su-c0f4f0de-73ad-464d-a13a-e5d96297bcb6",
          "kind": "message",
          "msg_id": "coord-send-6ed0e1d50df9971c50f10c122efc0c78c2b2184c652041a563c0fa323ac397cd",
          "basedOn": [
            {
              "ref": "work-item:WI-10006526",
              "via": "work_items:get",
              "readAt": "2026-10-22T23:14:25.098Z",
              "versionAtSend": "open@1792710386438"
            },
            {
              "ref": "work-item:WI-6554700010019379",
              "via": "work_items:get",
              "readAt": "2026-10-22T23:14:05.460Z",
              "versionAtSend": "wip@1792700045400"
            },
            {
              "ref": "work-item:WI-6554700010020921",
              "via": "work_items:get",
              "readAt": "2026-10-22T23:13:48.459Z",
              "versionAtSend": "blocked@1792710725874"
            },
            {
              "ref": "work-item:WI-6554700010020920",
              "via": "work_items:get",
              "readAt": "2026-10-22T23:13:07.266Z",
              "versionAtSend": "open@1792710725216"
            },
            {
              "ref": "work-item:EI-26711931152517691",
              "via": "work_items:get",
              "readAt": "2026-10-22T23:01:01.159Z",
              "versionAtSend": "open@1792701276077"
            }
          ],
          "expects": "none",
          "summary": "No verified command/fire join retained; stale phase attribution remains unproven",
          "awaiting": [
            {
              "ref": "work-item:WI-6554700010020921",
              "kind": "work-item-blocker",
              "blocker": "gate:plan-lane:sidecar-forkserver-2026-10-21#P-002"
            }
          ],
          "sections": [
            {
              "text": "I have no verified command correlation beyond the retained routine last_error (7200000ms) and old loaded source060876c3b0. WI-10006526 checkpoint43746c029525 explicitly corrects attribution: old withGitSyncPhase overwrote activePhase without restoring it; canonical12c415afc1 already uses activePhases Map/delete. Do not join your205545ms request to that timeout on this evidence. New instrumentation should identify the actual active interval/command; no duplicate phase fix is needed.",
              "forYouBecause": {
                "ref": "EI-26709724481565713",
                "relation": "owns"
              },
              "couldNotDetermine": [
                {
                  "what": "exact timeout fire/command correlation and actual time-consuming operation"
                }
              ]
            }
          ],
          "plan_slug": "sidecar-forkserver-2026-10-21",
          "harness_slug": "papercusp",
          "related_msg_id": "coord-send-6271cfb3350d97cdda87ebd5b8ef4f70afb0f2edaa3ef4fd80792003a4551e6d",
          "draftSuspension": {
            "gapMs": 1525106,
            "gapEndedAt": "2026-10-22T21:50:53.991Z",
            "openAtSend": false,
            "gapStartedAt": "2026-10-22T21:25:28.885Z"
          },
          "fieldProvenance": {
            "why": "goal-stamp-derived",
            "basedOn": "session-derived",
            "awaiting": "session-derived",
            "plan_slug": "presence-derived",
            "draftSuspension": "session-derived"
          },
          "premisesClassified": [
            []
          ],
          "authored": "∵ owns EI-26709724481565713 · ? undetermined: exact timeout fire/command correlation and actual time-consuming operation"
        }
      ],
      "recent": [
        "coord-send-6ed0e1d50df9971c50f10c122efc0c78c2b2184c652041a563c0fa323ac397cd"
      ],
      "injection": "context: 77772/220000 (35%); count source: watchdog-cached estimate\n[coord+1]\n- c0f4f No verified command/fire join retained; stale phase attribution remains unproven ⤷ re msg coord-send-6271cfb3350d97cdda87ebd5b8ef4f70afb0f2edaa3ef4fd80792003a4551e6d (424d5 → su-c0f4f0de-73ad-464d-a13a-e5d96297bcb6, 2026-10-22T23:13Z): \"Read WI10006526; joining existing EI267097 diagnosis with timeout/phase evidence (part 2/2) — ⟦part 2/2 g:a8414091 cont⟧ This decides whether to join my historical incident to your measured source co…\" ↪ WI-10006526 [bug/open in papercusp @c0f4f]: \"Git-sync live-file-lock refresh stalls until the 10-minute idle timeout — Owned WI-1000… ⌁ …@2026-10-11T02:51:33.167Z (since 2026-10-11T02:47:56.121Z)\" ⟨∵ owns EI-26709724481565713 · ? undetermined: exact timeout fire/command correlation and actual time-consuming operation⟩",
      "context_gauge": null
    },
    "d74-request": {
      "ok": true,
      "found": true,
      "msg_id": "coord-send-61efd690b48fc01c0ae414d9dfa51a5344ec6c91e2c14a8417a8bb44c59a5317",
      "message": {
        "to": [
          "su-424d5476-0b13-401a-a926-0aaa9f212391"
        ],
        "ts": "2026-10-22T23:22:31.148Z",
        "why": {
          "note": "Required committed inputs block the owned native acceptance run and audit source closure.",
          "goalRef": "WI-10007610"
        },
        "body": "Commit await350911 timed out; HEAD remains d32eae0110 and full mandatory native sourceguard still exits2 at bundle-host-common.sh. Your live Resume203 is unchanged on my read. Please advance the exact fire-to-command/receipt discrimination on owned EI-26709724481565713 and checkpoint whether commits can progress or what concrete step blocks them. Audit repair now also needs containment (47/47 tests passed). I have not fired another sync, restarted the host, or taken your lane.",
        "from": "su-d74d0101-2ce9-4082-8c02-5702a05e6ba3",
        "kind": "message",
        "wake": true,
        "msg_id": "coord-send-61efd690b48fc01c0ae414d9dfa51a5344ec6c91e2c14a8417a8bb44c59a5317",
        "basedOn": [
          {
            "ref": "work-item:EI-26709724481565713",
            "via": "work_items:get",
            "readAt": "2026-10-22T23:20:10.493Z",
            "versionAtSend": "open@1792697978229"
          },
          {
            "ref": "work-item:WI-6554700010018200",
            "via": "work_items:get",
            "readAt": "2026-10-22T23:11:54.054Z",
            "versionAtSend": "open@1792707972985"
          },
          {
            "ref": "work-item:EI-25949667985509297",
            "via": "work_items:get",
            "readAt": "2026-10-22T22:53:22.581Z",
            "versionAtSend": "done@1791977226483"
          },
          {
            "ref": "work-item:EI-26700949358255097",
            "via": "work_items:get",
            "readAt": "2026-10-22T22:53:17.968Z",
            "versionAtSend": "open@1792707962282"
          },
          {
            "ref": "work-item:EI-26720956346820754",
            "via": "work_items:get",
            "readAt": "2026-10-22T22:53:17.965Z",
            "versionAtSend": "open@1792710262950"
          },
          {
            "ref": "work-item:EI-26713464835685588",
            "via": "work_items:get",
            "readAt": "2026-10-22T22:53:17.954Z",
            "versionAtSend": "open@1792701545281"
          }
        ],
        "expects": "action",
        "receipt": true,
        "summary": "Commit dependency timed out again; drive the next discriminating git-sync probe and checkpoint concrete progress.",
        "awaiting": [
          {
            "ref": "work-item:WI-10000407",
            "kind": "work-item-blocker",
            "blocker": "runtime:work-item:WI-10007610"
          },
          {
            "ref": "work-item:WI-6554700010012159",
            "kind": "work-item-blocker",
            "blocker": "event:release:deployed"
          },
          {
            "ref": "work-item:WI-6554700010012159",
            "kind": "work-item-blocker",
            "blocker": "gate:deploy.3070.sha"
          }
        ],
        "sections": [
          {
            "text": "Commit await350911 timed out; HEAD remains d32eae0110 and full mandatory native sourceguard still exits2 at bundle-host-common.sh. Your live Resume203 is unchanged on my read. Please advance the exact fire-to-command/receipt discrimination on owned EI-26709724481565713 and checkpoint whether commits can progress or what concrete step blocks them. Audit repair now also needs containment (47/47 tests passed). I have not fired another sync, restarted the host, or taken your lane.",
            "forYouBecause": {
              "ref": "EI-26709724481565713",
              "relation": "owns"
            }
          }
        ],
        "staleBasis": [
          {
            "ref": "work-item:EI-26720956346820754",
            "readAt": "2026-10-22T22:53:17.965Z",
            "changedAt": "2026-10-22T23:04:22.950Z",
            "stateAtSend": "open",
            "versionAtSend": "open@1792710262950"
          }
        ],
        "wakeOnReply": true,
        "expectEffect": {
          "kind": "checkpoint",
          "itemId": "EI-26709724481565713",
          "harness": "papercusp"
        },
        "expectsReply": true,
        "harness_slug": "papercusp",
        "draftSuspension": {
          "gapMs": 2538016,
          "gapEndedAt": "2026-10-22T22:02:51.159Z",
          "openAtSend": false,
          "gapStartedAt": "2026-10-22T21:20:33.143Z"
        },
        "fieldProvenance": {
          "basedOn": "session-derived",
          "awaiting": "session-derived",
          "draftSuspension": "session-derived"
        },
        "replyDeadlineAt": 1792712251147,
        "premisesClassified": [
          []
        ]
      },
      "authored": {
        "expects": "action",
        "why": {
          "note": "Required committed inputs block the owned native acceptance run and audit source closure.",
          "goalRef": "WI-10007610"
        },
        "basedOn": [
          {
            "ref": "work-item:EI-26709724481565713",
            "via": "work_items:get",
            "readAt": "2026-10-22T23:20:10.493Z",
            "versionAtSend": "open@1792697978229"
          },
          {
            "ref": "work-item:WI-6554700010018200",
            "via": "work_items:get",
            "readAt": "2026-10-22T23:11:54.054Z",
            "versionAtSend": "open@1792707972985"
          },
          {
            "ref": "work-item:EI-25949667985509297",
            "via": "work_items:get",
            "readAt": "2026-10-22T22:53:22.581Z",
            "versionAtSend": "done@1791977226483"
          },
          {
            "ref": "work-item:EI-26700949358255097",
            "via": "work_items:get",
            "readAt": "2026-10-22T22:53:17.968Z",
            "versionAtSend": "open@1792707962282"
          },
          {
            "ref": "work-item:EI-26720956346820754",
            "via": "work_items:get",
            "readAt": "2026-10-22T22:53:17.965Z",
            "versionAtSend": "open@1792710262950"
          },
          {
            "ref": "work-item:EI-26713464835685588",
            "via": "work_items:get",
            "readAt": "2026-10-22T22:53:17.954Z",
            "versionAtSend": "open@1792701545281"
          }
        ],
        "sections": [
          {
            "text": "Commit await350911 timed out; HEAD remains d32eae0110 and full mandatory native sourceguard still exits2 at bundle-host-common.sh. Your live Resume203 is unchanged on my read. Please advance the exact fire-to-command/receipt discrimination on owned EI-26709724481565713 and checkpoint whether commits can progress or what concrete step blocks them. Audit repair now also needs containment (47/47 tests passed). I have not fired another sync, restarted the host, or taken your lane.",
            "forYouBecause": {
              "ref": "EI-26709724481565713",
              "relation": "owns"
            }
          }
        ],
        "derivedFields": [
          "basedOn",
          "awaiting",
          "draftSuspension"
        ]
      }
    },
    "lock-release": {
      "ok": true,
      "results": [
        {
          "ok": true,
          "lock_id": "1cb65444-17ee-45ea-a345-bbd4042ab4fa",
          "released": [
            "packages/operator-core/lib/harness/git-sync/git-sync-action.test.ts",
            "packages/operator-core/lib/harness/git-sync/git-sync-action.ts"
          ],
          "held_before": 2
        }
      ],
      "counts": {
        "ok": 1,
        "failed": 0
      }
    }
  },
  "preparedPayload": {
    "harness": "papercusp",
    "slug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
    "supersedeAtRevision": true,
    "items": [
      {
        "workItemId": "WI-6554700010008887",
        "specId": "AUTO-BAR-R-34-P-008",
        "specRevision": 1,
        "fromTestRun": 21784912,
        "sourcePaths": [
          "packages/operator-core/lib/scheduler/fleet-scope-admission.ts"
        ],
        "details": {
          "scope": "Three named rendered-guidance cases only;169 sibling cases filtered. Committed source and test exactly equal original run commit. No scheduler runtime or whole-file acceptance. Exact declared case identities recovered from canonical testing:runs; fixture calibration and falsifiability remain unasserted for this row.",
          "adequacy": {
            "outcome": "passed",
            "skipped": false,
            "executed": true,
            "collected": true,
            "testLayer": "unit",
            "testCases": [
              "fleet scope assignment admission (P-016) > EI-18663622382734446: a spec matching ZERO rows is named loudly, never folded into a bare drain > renders a bounded exact-event wake with timeout for a fully blocked agent"
            ],
            "targeted": "auto-bar-r-34-p-008"
          },
          "evidencePlane": "tree"
        }
      },
      {
        "workItemId": "WI-6554700010008887",
        "specId": "AUTO-BAR-R-33-P-008",
        "specRevision": 1,
        "fromTestRun": 21784912,
        "sourcePaths": [
          "packages/operator-core/lib/scheduler/fleet-scope-admission.ts"
        ],
        "details": {
          "scope": "Three named rendered-guidance cases only;169 sibling cases filtered. Committed source and test exactly equal original run commit. No scheduler runtime or whole-file acceptance. Exact declared case identities recovered from canonical testing:runs; fixture calibration and falsifiability remain unasserted for this row.",
          "adequacy": {
            "outcome": "passed",
            "skipped": false,
            "executed": true,
            "collected": true,
            "testLayer": "unit",
            "testCases": [
              "fleet scope assignment admission (P-016) > EI-18663622382734446: a spec matching ZERO rows is named loudly, never folded into a bare drain > renders continue-independent-work guidance for a partially blocked agent"
            ],
            "targeted": "auto-bar-r-33-p-008"
          },
          "evidencePlane": "tree"
        }
      },
      {
        "workItemId": "WI-6554700010008887",
        "specId": "AUTO-BAR-R-32-P-008",
        "specRevision": 1,
        "fromTestRun": 21784912,
        "sourcePaths": [
          "packages/operator-core/lib/scheduler/fleet-scope-admission.ts"
        ],
        "details": {
          "scope": "Three named rendered-guidance cases only;169 sibling cases filtered. Committed source and test exactly equal original run commit. No scheduler runtime or whole-file acceptance. Exact declared case identities recovered from canonical testing:runs; fixture calibration and falsifiability remain unasserted for this row.",
          "adequacy": {
            "outcome": "passed",
            "skipped": false,
            "executed": true,
            "collected": true,
            "testLayer": "unit",
            "testCases": [
              "fleet scope assignment admission (P-016) > EI-18663622382734446: a spec matching ZERO rows is named loudly, never folded into a bare drain > renders loop:end only for legitimate completion or stop when unfinished obligations are retained"
            ],
            "targeted": "auto-bar-r-32-p-008"
          },
          "evidencePlane": "tree"
        }
      },
      {
        "workItemId": "WI-6554700010008887",
        "specId": "AUTO-BAR-R-28-P-012",
        "specRevision": 1,
        "fromTestRun": 21784916,
        "sourcePaths": [
          "apps/operator/scripts/psu-pty-host.mjs"
        ],
        "details": {
          "scope": "Five named R28 host discovery writer cases only; 16 sibling cases filtered. Source and test equal the committed bytes of the original test run. No provider reset or live recovery claim. Exact declared case identities recovered from canonical testing:runs; fixture calibration and falsifiability remain unasserted for this row.",
          "adequacy": {
            "outcome": "passed",
            "skipped": false,
            "executed": true,
            "collected": true,
            "testLayer": "unit",
            "testCases": [
              "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['absolute local time']",
              "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['relative duration']",
              "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['ANSI and wrapped output']",
              "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['newest statement']",
              "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['no stated reset']"
            ],
            "targeted": "auto-bar-r-28-p-012"
          },
          "evidencePlane": "tree"
        }
      },
      {
        "workItemId": "WI-6554700010008887",
        "specId": "AUTO-BAR-R-28-P-004",
        "specRevision": 1,
        "fromTestRun": 21784916,
        "sourcePaths": [
          "apps/operator/scripts/psu-pty-host.mjs"
        ],
        "details": {
          "scope": "Five named R28 host discovery writer cases only; 16 sibling cases filtered. Source and test equal the committed bytes of the original test run. No provider reset or live recovery claim. Exact declared case identities recovered from canonical testing:runs; fixture calibration and falsifiability remain unasserted for this row.",
          "adequacy": {
            "outcome": "passed",
            "skipped": false,
            "executed": true,
            "collected": true,
            "testLayer": "unit",
            "testCases": [
              "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['absolute local time']",
              "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['relative duration']",
              "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['ANSI and wrapped output']",
              "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['newest statement']",
              "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['no stated reset']"
            ],
            "targeted": "auto-bar-r-28-p-004"
          },
          "evidencePlane": "tree"
        }
      },
      {
        "workItemId": "WI-6554700010008887",
        "specId": "AUTO-BAR-R-32-P-008",
        "specRevision": 1,
        "fromTestRun": 21338043,
        "sourcePaths": [
          "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
          "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
          "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
          "packages/operator-core/lib/scheduler/fleet-scope-admission.ts"
        ],
        "fixturePaths": [
          "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
          "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts"
        ],
        "details": {
          "scope": "Completed hermetic S41v4 unit/original LLM scenario proof on committed 7a0aea1229adb3561b53c9a8cad47b9792711406. Synthetic inline world; no live loop delivery, external review pickup, R14 census, gate or shipment claim. Reused for AUTO-BAR-R-32-P-008 after exact working/HEAD/pinned equality of every source, test and fixture; original terminal item untouched.",
          "adequacy": {
            "outcome": "passed",
            "skipped": false,
            "executed": true,
            "targeted": "auto-bar-r-32-p-008",
            "collected": true,
            "testCases": [
              "su-S41-scheduler-finished"
            ],
            "testLayer": "llm",
            "fixtureFree": false,
            "scenarioIds": [
              "s41-finished"
            ],
            "pathReachable": true,
            "fixtureCalibrated": true,
            "oracleIndependent": true
          },
          "proofRef": "artifact:papercusp/audits/parked-agent-resumption-2026-10-09/resume144-pinned-unit-model-mutation-proof-424d5.json",
          "calibration": {
            "negative": [
              "S41 actual scheduler advice behavior instrument > calibration: finished work stops, while missing-event work checkpoints and keeps its loop"
            ],
            "positive": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: finished",
            "testRunId": 21338017,
            "inlineFixturePaths": [
              "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
              "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts"
            ]
          },
          "evidencePlane": "live",
          "oracleRationale": "Expected properties are independently authored from S41-FINISHED-STOP / P-008 / D-009: stop the existing loop only after all requested work is complete and no retained obligation remains. The oracle replays observed tool effects and ordering, and does not copy fleetScopedMiss advice or trust SUT narrative. The unit suite accepts a valid trace and rejects the corresponding invalid trace; copy-out mutation 21338051 causes these exact negative guard cases to fail after passing baseline and copy baseline.",
          "runtimePlaneMeaning": "live labels the originally observed hermetic in-process witness certified through completedRuntime; no present PID, serving deployment or live-loop delivery is asserted.",
          "originBinding": {
            "planSlug": "adhoc-work-item-specs",
            "specId": "S41-FINISHED-STOP",
            "bindingId": 54269
          }
        },
        "completedRuntime": {
          "kind": "llm-in-process"
        }
      },
      {
        "workItemId": "WI-6554700010008887",
        "specId": "AUTO-BAR-R-32-P-008",
        "specRevision": 1,
        "fromTestRun": 21338029,
        "sourcePaths": [
          "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
          "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
          "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
          "packages/operator-core/lib/scheduler/fleet-scope-admission.ts"
        ],
        "fixturePaths": [
          "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
          "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts"
        ],
        "details": {
          "scope": "Completed hermetic S41v4 unit/original LLM scenario proof on committed 7a0aea1229adb3561b53c9a8cad47b9792711406. Synthetic inline world; no live loop delivery, external review pickup, R14 census, gate or shipment claim. Reused for AUTO-BAR-R-32-P-008 after exact working/HEAD/pinned equality of every source, test and fixture; original terminal item untouched.",
          "adequacy": {
            "outcome": "passed",
            "skipped": false,
            "executed": true,
            "targeted": "auto-bar-r-32-p-008",
            "collected": true,
            "testCases": [
              "su-S41-scheduler-no-event"
            ],
            "testLayer": "llm",
            "fixtureFree": false,
            "scenarioIds": [
              "s41-no-event"
            ],
            "pathReachable": true,
            "fixtureCalibrated": true,
            "oracleIndependent": true
          },
          "proofRef": "artifact:papercusp/audits/parked-agent-resumption-2026-10-09/resume144-pinned-unit-model-mutation-proof-424d5.json",
          "calibration": {
            "negative": [
              "S41 actual scheduler advice behavior instrument > rejects a backlog watch as retained-work wake, release of held work, invented blockers and duplicate loops",
              "S41 actual scheduler advice behavior instrument > rejects the observed fabricated peer-review ref without creating a dependency or stopping its loop"
            ],
            "positive": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: no-event",
            "testRunId": 21338017,
            "inlineFixturePaths": [
              "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
              "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts"
            ]
          },
          "evidencePlane": "live",
          "oracleRationale": "Expected properties are independently authored from S41-MISSING-EVENT / P-008 / D-009: preserve the existing loop and checkpoint without inventing a dependency. The oracle replays observed tool effects and ordering, and does not copy fleetScopedMiss advice or trust SUT narrative. The unit suite accepts a valid trace and rejects the corresponding invalid trace; copy-out mutation 21338076 causes these exact negative guard cases to fail after passing baseline and copy baseline.",
          "runtimePlaneMeaning": "live labels the originally observed hermetic in-process witness certified through completedRuntime; no present PID, serving deployment or live-loop delivery is asserted.",
          "originBinding": {
            "planSlug": "adhoc-work-item-specs",
            "specId": "S41-MISSING-EVENT",
            "bindingId": 54267
          }
        },
        "completedRuntime": {
          "kind": "llm-in-process"
        }
      },
      {
        "workItemId": "WI-6554700010008887",
        "specId": "AUTO-BAR-R-34-P-008",
        "specRevision": 1,
        "fromTestRun": 21338041,
        "sourcePaths": [
          "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
          "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
          "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
          "packages/operator-core/lib/scheduler/fleet-scope-admission.ts"
        ],
        "fixturePaths": [
          "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
          "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts"
        ],
        "details": {
          "scope": "Completed hermetic S41v4 unit/original LLM scenario proof on committed 7a0aea1229adb3561b53c9a8cad47b9792711406. Synthetic inline world; no live loop delivery, external review pickup, R14 census, gate or shipment claim. Reused for AUTO-BAR-R-34-P-008 after exact working/HEAD/pinned equality of every source, test and fixture; original terminal item untouched.",
          "adequacy": {
            "outcome": "passed",
            "skipped": false,
            "executed": true,
            "targeted": "auto-bar-r-34-p-008",
            "collected": true,
            "testCases": [
              "su-S41-scheduler-blocked"
            ],
            "testLayer": "llm",
            "fixtureFree": false,
            "scenarioIds": [
              "s41-blocked"
            ],
            "pathReachable": true,
            "fixtureCalibrated": true,
            "oracleIndependent": true
          },
          "proofRef": "artifact:papercusp/audits/parked-agent-resumption-2026-10-09/resume144-pinned-unit-model-mutation-proof-424d5.json",
          "calibration": {
            "negative": [
              "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":0,\"on_timeout\":\"wake\"}",
              "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":601,\"on_timeout\":\"wake\"}"
            ],
            "positive": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: blocked",
            "testRunId": 21338017,
            "inlineFixturePaths": [
              "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
              "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts"
            ]
          },
          "evidencePlane": "live",
          "oracleRationale": "Expected properties are independently authored from S41-BOUNDED-DEPENDENCY / P-008 / D-009: retain the claim and establish the exact positive bounded dependency wake before any loop stop. The oracle replays observed tool effects and ordering, and does not copy fleetScopedMiss advice or trust SUT narrative. The unit suite accepts a valid trace and rejects the corresponding invalid trace; copy-out mutation 21338077 causes these exact negative guard cases to fail after passing baseline and copy baseline.",
          "runtimePlaneMeaning": "live labels the originally observed hermetic in-process witness certified through completedRuntime; no present PID, serving deployment or live-loop delivery is asserted.",
          "originBinding": {
            "planSlug": "adhoc-work-item-specs",
            "specId": "S41-BOUNDED-DEPENDENCY",
            "bindingId": 54265
          }
        },
        "completedRuntime": {
          "kind": "llm-in-process"
        }
      },
      {
        "workItemId": "WI-6554700010008887",
        "specId": "AUTO-BAR-R-33-P-008",
        "specRevision": 1,
        "fromTestRun": 21338040,
        "sourcePaths": [
          "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
          "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
          "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
          "packages/operator-core/lib/scheduler/fleet-scope-admission.ts"
        ],
        "fixturePaths": [
          "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
          "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts"
        ],
        "details": {
          "scope": "Completed hermetic S41v4 unit/original LLM scenario proof on committed 7a0aea1229adb3561b53c9a8cad47b9792711406. Synthetic inline world; no live loop delivery, external review pickup, R14 census, gate or shipment claim. Reused for AUTO-BAR-R-33-P-008 after exact working/HEAD/pinned equality of every source, test and fixture; original terminal item untouched.",
          "adequacy": {
            "outcome": "passed",
            "skipped": false,
            "executed": true,
            "targeted": "auto-bar-r-33-p-008",
            "collected": true,
            "testCases": [
              "su-S41-scheduler-independent"
            ],
            "testLayer": "llm",
            "fixtureFree": false,
            "scenarioIds": [
              "s41-independent"
            ],
            "pathReachable": true,
            "fixtureCalibrated": true,
            "oracleIndependent": true
          },
          "proofRef": "artifact:papercusp/audits/parked-agent-resumption-2026-10-09/resume144-pinned-unit-model-mutation-proof-424d5.json",
          "calibration": {
            "negative": [
              "S41 actual scheduler advice behavior instrument > executes the advertised files selector and refuses undocumented guesses",
              "S41 actual scheduler advice behavior instrument > still rejects awaiting an existing blocker before finishing independent work",
              "S41 actual scheduler advice behavior instrument > rejects stop-first advice even when a later bounded await succeeds"
            ],
            "positive": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: independent",
            "testRunId": 21338017,
            "inlineFixturePaths": [
              "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
              "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts"
            ]
          },
          "evidencePlane": "live",
          "oracleRationale": "Expected properties are independently authored from S41-INDEPENDENT-WORK / P-008 / D-009: complete the known independent test action before awaiting the exact peer dependency. The oracle replays observed tool effects and ordering, and does not copy fleetScopedMiss advice or trust SUT narrative. The unit suite accepts a valid trace and rejects the corresponding invalid trace; copy-out mutation 21338047 causes these exact negative guard cases to fail after passing baseline and copy baseline.",
          "runtimePlaneMeaning": "live labels the originally observed hermetic in-process witness certified through completedRuntime; no present PID, serving deployment or live-loop delivery is asserted.",
          "originBinding": {
            "planSlug": "adhoc-work-item-specs",
            "specId": "S41-INDEPENDENT-WORK",
            "bindingId": 54263
          }
        },
        "completedRuntime": {
          "kind": "llm-in-process"
        }
      },
      {
        "workItemId": "WI-6554700010008887",
        "specId": "AUTO-BAR-R-32-P-008",
        "specRevision": 1,
        "fromTestRun": 21338017,
        "sourcePaths": [
          "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
          "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
          "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
          "packages/operator-core/lib/scheduler/fleet-scope-admission.ts"
        ],
        "fixturePaths": [
          "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
          "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts"
        ],
        "details": {
          "scope": "Completed hermetic S41v4 unit/original LLM scenario proof on committed 7a0aea1229adb3561b53c9a8cad47b9792711406. Synthetic inline world; no live loop delivery, external review pickup, R14 census, gate or shipment claim. Reused for AUTO-BAR-R-32-P-008 after exact working/HEAD/pinned equality of every source, test and fixture; original terminal item untouched.",
          "adequacy": {
            "outcome": "passed",
            "skipped": false,
            "executed": true,
            "targeted": "auto-bar-r-32-p-008",
            "collected": true,
            "testCases": [
              "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: finished",
              "S41 actual scheduler advice behavior instrument > calibration: finished work stops, while missing-event work checkpoints and keeps its loop"
            ],
            "testLayer": "unit",
            "fixtureFree": false,
            "scenarioIds": [
              "s41-finished"
            ],
            "pathReachable": true,
            "fixtureCalibrated": true,
            "oracleIndependent": true
          },
          "proofRef": "artifact:papercusp/audits/parked-agent-resumption-2026-10-09/resume144-pinned-unit-model-mutation-proof-424d5.json",
          "calibration": {
            "negative": [
              "S41 actual scheduler advice behavior instrument > calibration: finished work stops, while missing-event work checkpoints and keeps its loop"
            ],
            "positive": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: finished",
            "testRunId": 21338017,
            "inlineFixturePaths": [
              "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
              "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts"
            ]
          },
          "oracleRationale": "Expected properties are independently authored from S41-FINISHED-STOP / P-008 / D-009: stop the existing loop only after all requested work is complete and no retained obligation remains. The oracle replays observed tool effects and ordering, and does not copy fleetScopedMiss advice or trust SUT narrative. The unit suite accepts a valid trace and rejects the corresponding invalid trace; copy-out mutation 21338051 causes these exact negative guard cases to fail after passing baseline and copy baseline.",
          "originBinding": {
            "planSlug": "adhoc-work-item-specs",
            "specId": "S41-FINISHED-STOP",
            "bindingId": 54260
          },
          "evidencePlane": "tree"
        }
      },
      {
        "workItemId": "WI-6554700010008887",
        "specId": "AUTO-BAR-R-32-P-008",
        "specRevision": 1,
        "fromTestRun": 21338017,
        "sourcePaths": [
          "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
          "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
          "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
          "packages/operator-core/lib/scheduler/fleet-scope-admission.ts"
        ],
        "fixturePaths": [
          "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
          "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts"
        ],
        "details": {
          "scope": "Completed hermetic S41v4 unit/original LLM scenario proof on committed 7a0aea1229adb3561b53c9a8cad47b9792711406. Synthetic inline world; no live loop delivery, external review pickup, R14 census, gate or shipment claim. Reused for AUTO-BAR-R-32-P-008 after exact working/HEAD/pinned equality of every source, test and fixture; original terminal item untouched.",
          "adequacy": {
            "outcome": "passed",
            "skipped": false,
            "executed": true,
            "targeted": "auto-bar-r-32-p-008",
            "collected": true,
            "testCases": [
              "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: no-event",
              "S41 actual scheduler advice behavior instrument > rejects a backlog watch as retained-work wake, release of held work, invented blockers and duplicate loops",
              "S41 actual scheduler advice behavior instrument > rejects the observed fabricated peer-review ref without creating a dependency or stopping its loop"
            ],
            "testLayer": "unit",
            "fixtureFree": false,
            "scenarioIds": [
              "s41-no-event"
            ],
            "pathReachable": true,
            "fixtureCalibrated": true,
            "oracleIndependent": true
          },
          "proofRef": "artifact:papercusp/audits/parked-agent-resumption-2026-10-09/resume144-pinned-unit-model-mutation-proof-424d5.json",
          "calibration": {
            "negative": [
              "S41 actual scheduler advice behavior instrument > rejects a backlog watch as retained-work wake, release of held work, invented blockers and duplicate loops",
              "S41 actual scheduler advice behavior instrument > rejects the observed fabricated peer-review ref without creating a dependency or stopping its loop"
            ],
            "positive": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: no-event",
            "testRunId": 21338017,
            "inlineFixturePaths": [
              "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
              "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts"
            ]
          },
          "oracleRationale": "Expected properties are independently authored from S41-MISSING-EVENT / P-008 / D-009: preserve the existing loop and checkpoint without inventing a dependency. The oracle replays observed tool effects and ordering, and does not copy fleetScopedMiss advice or trust SUT narrative. The unit suite accepts a valid trace and rejects the corresponding invalid trace; copy-out mutation 21338076 causes these exact negative guard cases to fail after passing baseline and copy baseline.",
          "originBinding": {
            "planSlug": "adhoc-work-item-specs",
            "specId": "S41-MISSING-EVENT",
            "bindingId": 54258
          },
          "evidencePlane": "tree"
        }
      },
      {
        "workItemId": "WI-6554700010008887",
        "specId": "AUTO-BAR-R-34-P-008",
        "specRevision": 1,
        "fromTestRun": 21338017,
        "sourcePaths": [
          "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
          "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
          "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
          "packages/operator-core/lib/scheduler/fleet-scope-admission.ts"
        ],
        "fixturePaths": [
          "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
          "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts"
        ],
        "details": {
          "scope": "Completed hermetic S41v4 unit/original LLM scenario proof on committed 7a0aea1229adb3561b53c9a8cad47b9792711406. Synthetic inline world; no live loop delivery, external review pickup, R14 census, gate or shipment claim. Reused for AUTO-BAR-R-34-P-008 after exact working/HEAD/pinned equality of every source, test and fixture; original terminal item untouched.",
          "adequacy": {
            "outcome": "passed",
            "skipped": false,
            "executed": true,
            "targeted": "auto-bar-r-34-p-008",
            "collected": true,
            "testCases": [
              "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: blocked",
              "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":0,\"on_timeout\":\"wake\"}",
              "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":601,\"on_timeout\":\"wake\"}"
            ],
            "testLayer": "unit",
            "fixtureFree": false,
            "scenarioIds": [
              "s41-blocked"
            ],
            "pathReachable": true,
            "fixtureCalibrated": true,
            "oracleIndependent": true
          },
          "proofRef": "artifact:papercusp/audits/parked-agent-resumption-2026-10-09/resume144-pinned-unit-model-mutation-proof-424d5.json",
          "calibration": {
            "negative": [
              "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":0,\"on_timeout\":\"wake\"}",
              "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":601,\"on_timeout\":\"wake\"}"
            ],
            "positive": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: blocked",
            "testRunId": 21338017,
            "inlineFixturePaths": [
              "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
              "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts"
            ]
          },
          "oracleRationale": "Expected properties are independently authored from S41-BOUNDED-DEPENDENCY / P-008 / D-009: retain the claim and establish the exact positive bounded dependency wake before any loop stop. The oracle replays observed tool effects and ordering, and does not copy fleetScopedMiss advice or trust SUT narrative. The unit suite accepts a valid trace and rejects the corresponding invalid trace; copy-out mutation 21338077 causes these exact negative guard cases to fail after passing baseline and copy baseline.",
          "originBinding": {
            "planSlug": "adhoc-work-item-specs",
            "specId": "S41-BOUNDED-DEPENDENCY",
            "bindingId": 54256
          },
          "evidencePlane": "tree"
        }
      },
      {
        "workItemId": "WI-6554700010008887",
        "specId": "AUTO-BAR-R-33-P-008",
        "specRevision": 1,
        "fromTestRun": 21338017,
        "sourcePaths": [
          "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
          "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
          "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
          "packages/operator-core/lib/scheduler/fleet-scope-admission.ts"
        ],
        "fixturePaths": [
          "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
          "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts"
        ],
        "details": {
          "scope": "Completed hermetic S41v4 unit/original LLM scenario proof on committed 7a0aea1229adb3561b53c9a8cad47b9792711406. Synthetic inline world; no live loop delivery, external review pickup, R14 census, gate or shipment claim. Reused for AUTO-BAR-R-33-P-008 after exact working/HEAD/pinned equality of every source, test and fixture; original terminal item untouched.",
          "adequacy": {
            "outcome": "passed",
            "skipped": false,
            "executed": true,
            "targeted": "auto-bar-r-33-p-008",
            "collected": true,
            "testCases": [
              "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: independent",
              "S41 actual scheduler advice behavior instrument > executes the advertised files selector and refuses undocumented guesses",
              "S41 actual scheduler advice behavior instrument > still rejects awaiting an existing blocker before finishing independent work",
              "S41 actual scheduler advice behavior instrument > rejects stop-first advice even when a later bounded await succeeds"
            ],
            "testLayer": "unit",
            "fixtureFree": false,
            "scenarioIds": [
              "s41-independent"
            ],
            "pathReachable": true,
            "fixtureCalibrated": true,
            "oracleIndependent": true
          },
          "proofRef": "artifact:papercusp/audits/parked-agent-resumption-2026-10-09/resume144-pinned-unit-model-mutation-proof-424d5.json",
          "calibration": {
            "negative": [
              "S41 actual scheduler advice behavior instrument > executes the advertised files selector and refuses undocumented guesses",
              "S41 actual scheduler advice behavior instrument > still rejects awaiting an existing blocker before finishing independent work",
              "S41 actual scheduler advice behavior instrument > rejects stop-first advice even when a later bounded await succeeds"
            ],
            "positive": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: independent",
            "testRunId": 21338017,
            "inlineFixturePaths": [
              "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
              "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts"
            ]
          },
          "oracleRationale": "Expected properties are independently authored from S41-INDEPENDENT-WORK / P-008 / D-009: complete the known independent test action before awaiting the exact peer dependency. The oracle replays observed tool effects and ordering, and does not copy fleetScopedMiss advice or trust SUT narrative. The unit suite accepts a valid trace and rejects the corresponding invalid trace; copy-out mutation 21338047 causes these exact negative guard cases to fail after passing baseline and copy baseline.",
          "originBinding": {
            "planSlug": "adhoc-work-item-specs",
            "specId": "S41-INDEPENDENT-WORK",
            "bindingId": 54254
          },
          "evidencePlane": "tree"
        }
      },
      {
        "workItemId": "WI-6554700010008887",
        "specId": "AUTO-BAR-R-32-P-008",
        "specRevision": 1,
        "fromTestRun": 21338051,
        "sourcePaths": [
          "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
          "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
          "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
          "packages/operator-core/lib/scheduler/fleet-scope-admission.ts"
        ],
        "fixturePaths": [
          "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
          "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts"
        ],
        "details": {
          "scope": "Completed hermetic S41v4 unit/original LLM scenario proof on committed 7a0aea1229adb3561b53c9a8cad47b9792711406. Synthetic inline world; no live loop delivery, external review pickup, R14 census, gate or shipment claim. Reused for AUTO-BAR-R-32-P-008 after exact working/HEAD/pinned equality of every source, test and fixture; original terminal item untouched.",
          "adequacy": {
            "outcome": "caught",
            "skipped": false,
            "executed": true,
            "targeted": "auto-bar-r-32-p-008",
            "collected": true,
            "testCases": [
              "S41 actual scheduler advice behavior instrument > calibration: finished work stops, while missing-event work checkpoints and keeps its loop"
            ],
            "testLayer": "unit",
            "fixtureFree": false,
            "scenarioIds": [
              "s41-finished"
            ],
            "pathReachable": true,
            "fixtureCalibrated": true,
            "oracleIndependent": true
          },
          "proofRef": "artifact:papercusp/audits/parked-agent-resumption-2026-10-09/resume144-pinned-unit-model-mutation-proof-424d5.json",
          "calibration": {
            "negative": [
              "S41 actual scheduler advice behavior instrument > calibration: finished work stops, while missing-event work checkpoints and keeps its loop"
            ],
            "positive": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: finished",
            "testRunId": 21338017,
            "inlineFixturePaths": [
              "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
              "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts"
            ]
          },
          "oracleRationale": "Expected properties are independently authored from S41-FINISHED-STOP / P-008 / D-009: stop the existing loop only after all requested work is complete and no retained obligation remains. The oracle replays observed tool effects and ordering, and does not copy fleetScopedMiss advice or trust SUT narrative. The unit suite accepts a valid trace and rejects the corresponding invalid trace; copy-out mutation 21338051 causes these exact negative guard cases to fail after passing baseline and copy baseline.",
          "originBinding": {
            "planSlug": "adhoc-work-item-specs",
            "specId": "S41-FINISHED-STOP",
            "bindingId": 54252
          },
          "evidencePlane": "tree"
        },
        "canonicalTestPath": "test-run 21338051 mutation-probe mutant fail packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts @7a0aea1229ad"
      },
      {
        "workItemId": "WI-6554700010008887",
        "specId": "AUTO-BAR-R-32-P-008",
        "specRevision": 1,
        "fromTestRun": 21338076,
        "sourcePaths": [
          "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
          "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
          "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
          "packages/operator-core/lib/scheduler/fleet-scope-admission.ts"
        ],
        "fixturePaths": [
          "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
          "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts"
        ],
        "details": {
          "scope": "Completed hermetic S41v4 unit/original LLM scenario proof on committed 7a0aea1229adb3561b53c9a8cad47b9792711406. Synthetic inline world; no live loop delivery, external review pickup, R14 census, gate or shipment claim. Reused for AUTO-BAR-R-32-P-008 after exact working/HEAD/pinned equality of every source, test and fixture; original terminal item untouched.",
          "adequacy": {
            "outcome": "caught",
            "skipped": false,
            "executed": true,
            "targeted": "auto-bar-r-32-p-008",
            "collected": true,
            "testCases": [
              "S41 actual scheduler advice behavior instrument > rejects a backlog watch as retained-work wake, release of held work, invented blockers and duplicate loops",
              "S41 actual scheduler advice behavior instrument > rejects the observed fabricated peer-review ref without creating a dependency or stopping its loop"
            ],
            "testLayer": "unit",
            "fixtureFree": false,
            "scenarioIds": [
              "s41-no-event"
            ],
            "pathReachable": true,
            "fixtureCalibrated": true,
            "oracleIndependent": true
          },
          "proofRef": "artifact:papercusp/audits/parked-agent-resumption-2026-10-09/resume144-pinned-unit-model-mutation-proof-424d5.json",
          "calibration": {
            "negative": [
              "S41 actual scheduler advice behavior instrument > rejects a backlog watch as retained-work wake, release of held work, invented blockers and duplicate loops",
              "S41 actual scheduler advice behavior instrument > rejects the observed fabricated peer-review ref without creating a dependency or stopping its loop"
            ],
            "positive": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: no-event",
            "testRunId": 21338017,
            "inlineFixturePaths": [
              "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
              "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts"
            ]
          },
          "oracleRationale": "Expected properties are independently authored from S41-MISSING-EVENT / P-008 / D-009: preserve the existing loop and checkpoint without inventing a dependency. The oracle replays observed tool effects and ordering, and does not copy fleetScopedMiss advice or trust SUT narrative. The unit suite accepts a valid trace and rejects the corresponding invalid trace; copy-out mutation 21338076 causes these exact negative guard cases to fail after passing baseline and copy baseline.",
          "originBinding": {
            "planSlug": "adhoc-work-item-specs",
            "specId": "S41-MISSING-EVENT",
            "bindingId": 54249
          },
          "evidencePlane": "tree"
        },
        "canonicalTestPath": "test-run 21338076 mutation-probe mutant fail packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts @7a0aea1229ad"
      },
      {
        "workItemId": "WI-6554700010008887",
        "specId": "AUTO-BAR-R-34-P-008",
        "specRevision": 1,
        "fromTestRun": 21338077,
        "sourcePaths": [
          "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
          "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
          "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
          "packages/operator-core/lib/scheduler/fleet-scope-admission.ts"
        ],
        "fixturePaths": [
          "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
          "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts"
        ],
        "details": {
          "scope": "Completed hermetic S41v4 unit/original LLM scenario proof on committed 7a0aea1229adb3561b53c9a8cad47b9792711406. Synthetic inline world; no live loop delivery, external review pickup, R14 census, gate or shipment claim. Reused for AUTO-BAR-R-34-P-008 after exact working/HEAD/pinned equality of every source, test and fixture; original terminal item untouched.",
          "adequacy": {
            "outcome": "caught",
            "skipped": false,
            "executed": true,
            "targeted": "auto-bar-r-34-p-008",
            "collected": true,
            "testCases": [
              "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":0,\"on_timeout\":\"wake\"}",
              "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":601,\"on_timeout\":\"wake\"}"
            ],
            "testLayer": "unit",
            "fixtureFree": false,
            "scenarioIds": [
              "s41-blocked"
            ],
            "pathReachable": true,
            "fixtureCalibrated": true,
            "oracleIndependent": true
          },
          "proofRef": "artifact:papercusp/audits/parked-agent-resumption-2026-10-09/resume144-pinned-unit-model-mutation-proof-424d5.json",
          "calibration": {
            "negative": [
              "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":0,\"on_timeout\":\"wake\"}",
              "S41 actual scheduler advice behavior instrument > does not count rejected/unbounded/self-action awaits as wake proof: {\"event\":\"harness:widget:peer-review:ready\",\"timeout_sec\":601,\"on_timeout\":\"wake\"}"
            ],
            "positive": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: blocked",
            "testRunId": 21338017,
            "inlineFixturePaths": [
              "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
              "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts"
            ]
          },
          "oracleRationale": "Expected properties are independently authored from S41-BOUNDED-DEPENDENCY / P-008 / D-009: retain the claim and establish the exact positive bounded dependency wake before any loop stop. The oracle replays observed tool effects and ordering, and does not copy fleetScopedMiss advice or trust SUT narrative. The unit suite accepts a valid trace and rejects the corresponding invalid trace; copy-out mutation 21338077 causes these exact negative guard cases to fail after passing baseline and copy baseline.",
          "originBinding": {
            "planSlug": "adhoc-work-item-specs",
            "specId": "S41-BOUNDED-DEPENDENCY",
            "bindingId": 54246
          },
          "evidencePlane": "tree"
        },
        "canonicalTestPath": "test-run 21338077 mutation-probe mutant fail packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts @7a0aea1229ad"
      },
      {
        "workItemId": "WI-6554700010008887",
        "specId": "AUTO-BAR-R-33-P-008",
        "specRevision": 1,
        "fromTestRun": 21338047,
        "sourcePaths": [
          "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
          "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
          "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
          "packages/operator-core/lib/scheduler/fleet-scope-admission.ts"
        ],
        "fixturePaths": [
          "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
          "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts"
        ],
        "details": {
          "scope": "Completed hermetic S41v4 unit/original LLM scenario proof on committed 7a0aea1229adb3561b53c9a8cad47b9792711406. Synthetic inline world; no live loop delivery, external review pickup, R14 census, gate or shipment claim. Reused for AUTO-BAR-R-33-P-008 after exact working/HEAD/pinned equality of every source, test and fixture; original terminal item untouched.",
          "adequacy": {
            "outcome": "caught",
            "skipped": false,
            "executed": true,
            "targeted": "auto-bar-r-33-p-008",
            "collected": true,
            "testCases": [
              "S41 actual scheduler advice behavior instrument > executes the advertised files selector and refuses undocumented guesses",
              "S41 actual scheduler advice behavior instrument > still rejects awaiting an existing blocker before finishing independent work",
              "S41 actual scheduler advice behavior instrument > rejects stop-first advice even when a later bounded await succeeds"
            ],
            "testLayer": "unit",
            "fixtureFree": false,
            "scenarioIds": [
              "s41-independent"
            ],
            "pathReachable": true,
            "fixtureCalibrated": true,
            "oracleIndependent": true
          },
          "proofRef": "artifact:papercusp/audits/parked-agent-resumption-2026-10-09/resume144-pinned-unit-model-mutation-proof-424d5.json",
          "calibration": {
            "negative": [
              "S41 actual scheduler advice behavior instrument > executes the advertised files selector and refuses undocumented guesses",
              "S41 actual scheduler advice behavior instrument > still rejects awaiting an existing blocker before finishing independent work",
              "S41 actual scheduler advice behavior instrument > rejects stop-first advice even when a later bounded await succeeds"
            ],
            "positive": "S41 actual scheduler advice behavior instrument > accepts both scripted user turns with legitimate effects: independent",
            "testRunId": 21338017,
            "inlineFixturePaths": [
              "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
              "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts"
            ]
          },
          "oracleRationale": "Expected properties are independently authored from S41-INDEPENDENT-WORK / P-008 / D-009: complete the known independent test action before awaiting the exact peer dependency. The oracle replays observed tool effects and ordering, and does not copy fleetScopedMiss advice or trust SUT narrative. The unit suite accepts a valid trace and rejects the corresponding invalid trace; copy-out mutation 21338047 causes these exact negative guard cases to fail after passing baseline and copy baseline.",
          "originBinding": {
            "planSlug": "adhoc-work-item-specs",
            "specId": "S41-INDEPENDENT-WORK",
            "bindingId": 54243
          },
          "evidencePlane": "tree"
        },
        "canonicalTestPath": "test-run 21338047 mutation-probe mutant fail packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts @7a0aea1229ad"
      }
    ],
    "payloadTier": "full"
  },
  "diagnosticDesign": {
    "status": "prepared only; no source edits",
    "reuse": "extend existing GitSyncActivityMarker and actual runGit injection; no new state read tool or service",
    "source": "packages/operator-core/lib/harness/git-sync/git-sync-action.ts",
    "test": "packages/operator-core/lib/harness/git-sync/git-sync-action.test.ts",
    "design": "Fire-owned bounded active command map, command id/subcommand/cwd/started_at; capture immutable timeout snapshot before queued metadata; retain existing activeGitExecutions lifetime/lease semantics; settled commands removed; reuse fleet/sidecar-read-only-git gitSubcommandOf to avoid raw argv/credentials. Test actual injected runner held at timeout, parallel commands, settlement cleanup, no raw secret argv. Existing phase-map patch must be preserved."
  }
}
