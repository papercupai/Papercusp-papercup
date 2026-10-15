---
rel_path: "audits/parked-agent-resumption-2026-10-09/fire54-current-refresh-results-20261015-424d5.json"
updated_at: 1792026044465
_body: "content"
---

{
  "schemaVersion": "parked-fire54-refresh-results-v1",
  "observedAt": "2026-10-15T01:00:37.936553+00:00",
  "ownerId": "su-424d5476-0b13-401a-a926-0aaa9f212391",
  "workItem": "WI-6554700010008887",
  "comparison": [
    {
      "bar": "R-12",
      "bindingId": 39073,
      "files": [
        {
          "path": "apps/operator/bin/bundle-host.sh",
          "dimension": "source",
          "acceptedSha256": "a7e7650b7887b691d890a32d3f7d406b333c9e139cd13c1b5deef9678156844a",
          "currentSha256": "cacd91c424cbc9afaea5742ea5c636606abea1469ef270ca04bd8924792c6dfe",
          "matches": false
        },
        {
          "path": "apps/operator/bin/hono-host.ts",
          "dimension": "source",
          "acceptedSha256": "611708b9bd17e8464a84168251b918f8991f4bb270bf34e67921f8bea4efd98d",
          "currentSha256": "611708b9bd17e8464a84168251b918f8991f4bb270bf34e67921f8bea4efd98d",
          "matches": true
        },
        {
          "path": "packages/operator-core/lib/agent-tools/coordination/escalations.ts",
          "dimension": "source",
          "acceptedSha256": "2ce6c37f1b9fb80b74402c6f77feca45a5dc49b97c370daed70796386b54bf52",
          "currentSha256": "2ce6c37f1b9fb80b74402c6f77feca45a5dc49b97c370daed70796386b54bf52",
          "matches": true
        },
        {
          "path": "packages/operator-core/lib/build-info.ts",
          "dimension": "source",
          "acceptedSha256": "6d271f5721a0d47c68fa8f42996a34f7b48fe4c06e414285a3f7fe36bdc44a50",
          "currentSha256": "6d271f5721a0d47c68fa8f42996a34f7b48fe4c06e414285a3f7fe36bdc44a50",
          "matches": true
        },
        {
          "path": "packages/operator-core/lib/derived-reads/shared-snapshot.ts",
          "dimension": "source",
          "acceptedSha256": "ab154eea455bfe4290e65f664456a15360cf4151e3a6acfcc7bb9ed666c22826",
          "currentSha256": "ab154eea455bfe4290e65f664456a15360cf4151e3a6acfcc7bb9ed666c22826",
          "matches": true
        },
        {
          "path": "packages/operator-core/lib/system-health/agent-strand-census.ts",
          "dimension": "source",
          "acceptedSha256": "f90607aafce701501836475b2f328eedc80d50eb620d2ba7b5555378908cf284",
          "currentSha256": "f90607aafce701501836475b2f328eedc80d50eb620d2ba7b5555378908cf284",
          "matches": true
        },
        {
          "path": "packages/operator-core/lib/system-health/compute.ts",
          "dimension": "source",
          "acceptedSha256": "529241e60ae0bbbbba53942104ffb5ee657d440d468f95485130c16ab65e5909",
          "currentSha256": "caabb259b0a63fc5cb522c926ee52ed8f39185a07cf6c9e332db9ed68c031d75",
          "matches": false
        },
        {
          "path": "packages/operator-core/lib/system-health/liveness-alarm.ts",
          "dimension": "source",
          "acceptedSha256": "674c3b2ef1e4c01843aef5b382951c1f59c5c0db36b0c9fbd7f0dbe634292b39",
          "currentSha256": "f46b54aebc449cf0616ae0a457924cb59fcac18d724e845fb0f3af7628b4853f",
          "matches": false
        },
        {
          "path": "packages/operator-core/test/isolated-integration-proof.ts",
          "dimension": "source",
          "acceptedSha256": "f83062e0b241b972db751ea5fddcb64e6b4f52db001f7fbfaab1c400cd140dba",
          "currentSha256": "62dd3348dd79c446af03397d5b17eadc7bd611cfb360f1089bce55714b84eae1",
          "matches": false
        },
        {
          "path": "packages/operator-core/test/liveness-alarm-http-fixture.ts",
          "dimension": "source",
          "acceptedSha256": "0c827e616987ffc5c85e32d8e8784213a8b63f8a1137b7906c006352248b7b1a",
          "currentSha256": "111e94ed9fb373abb4376cfae0fde6016770359fbf74d6aee6eb9739614a3f52",
          "matches": false
        },
        {
          "path": "packages/operator-core/test/private-http-workspace-preflight.ts",
          "dimension": "source",
          "acceptedSha256": "91473d3ec52d4672806c53377210e45dea8f5f7b4463d4a898fbf4fb22d63c16",
          "currentSha256": "4e1b727cadbf96a4f53ba2f20635bea0cbcc429b7babb6996552726044c03991",
          "matches": false
        },
        {
          "path": "scripts/lib/isolated-runtime-start.mjs",
          "dimension": "source",
          "acceptedSha256": "f604dc115a6f22e3d84a1b9ad332d89f615d418f751ef20d3bcbc021ea32033d",
          "currentSha256": "f604dc115a6f22e3d84a1b9ad332d89f615d418f751ef20d3bcbc021ea32033d",
          "matches": true
        },
        {
          "path": "scripts/with-test-pg.mjs",
          "dimension": "source",
          "acceptedSha256": "d2ed7c124b8cba57303f8350b0d942df2a807d68409d1ac11fad7cb39054334b",
          "currentSha256": "c5b091686531409443a86b582dfd2f9c465a8b9d7055c752354df490be87f750",
          "matches": false
        },
        {
          "path": "packages/operator-core/lib/system-health/liveness-alarm-current-build.e2e.test.ts",
          "dimension": "test",
          "acceptedSha256": "cc2e7abffb24f45eed27e539a98a3ebf1100ffebaf02b7f0aa39e2e934fcc96f",
          "currentSha256": "f62bf14b6ae06d361333052e888d578f04a04e255a1b722c05ad493d8cd2f2f6",
          "matches": false
        },
        {
          "path": "packages/operator-core/test/liveness-alarm-http-fixture.ts",
          "dimension": "fixture",
          "acceptedSha256": "0c827e616987ffc5c85e32d8e8784213a8b63f8a1137b7906c006352248b7b1a",
          "currentSha256": "111e94ed9fb373abb4376cfae0fde6016770359fbf74d6aee6eb9739614a3f52",
          "matches": false
        },
        {
          "path": "packages/operator-core/test/private-http-workspace-preflight.ts",
          "dimension": "fixture",
          "acceptedSha256": "91473d3ec52d4672806c53377210e45dea8f5f7b4463d4a898fbf4fb22d63c16",
          "currentSha256": "4e1b727cadbf96a4f53ba2f20635bea0cbcc429b7babb6996552726044c03991",
          "matches": false
        }
      ]
    },
    {
      "bar": "R-12",
      "bindingId": 39074,
      "files": [
        {
          "path": "apps/operator/bin/bundle-host.sh",
          "dimension": "source",
          "acceptedSha256": "a7e7650b7887b691d890a32d3f7d406b333c9e139cd13c1b5deef9678156844a",
          "currentSha256": "cacd91c424cbc9afaea5742ea5c636606abea1469ef270ca04bd8924792c6dfe",
          "matches": false
        },
        {
          "path": "apps/operator/bin/hono-host.ts",
          "dimension": "source",
          "acceptedSha256": "611708b9bd17e8464a84168251b918f8991f4bb270bf34e67921f8bea4efd98d",
          "currentSha256": "611708b9bd17e8464a84168251b918f8991f4bb270bf34e67921f8bea4efd98d",
          "matches": true
        },
        {
          "path": "packages/operator-core/lib/agent-tools/coordination/escalations.ts",
          "dimension": "source",
          "acceptedSha256": "2ce6c37f1b9fb80b74402c6f77feca45a5dc49b97c370daed70796386b54bf52",
          "currentSha256": "2ce6c37f1b9fb80b74402c6f77feca45a5dc49b97c370daed70796386b54bf52",
          "matches": true
        },
        {
          "path": "packages/operator-core/lib/build-info.ts",
          "dimension": "source",
          "acceptedSha256": "6d271f5721a0d47c68fa8f42996a34f7b48fe4c06e414285a3f7fe36bdc44a50",
          "currentSha256": "6d271f5721a0d47c68fa8f42996a34f7b48fe4c06e414285a3f7fe36bdc44a50",
          "matches": true
        },
        {
          "path": "packages/operator-core/lib/derived-reads/shared-snapshot.ts",
          "dimension": "source",
          "acceptedSha256": "ab154eea455bfe4290e65f664456a15360cf4151e3a6acfcc7bb9ed666c22826",
          "currentSha256": "ab154eea455bfe4290e65f664456a15360cf4151e3a6acfcc7bb9ed666c22826",
          "matches": true
        },
        {
          "path": "packages/operator-core/lib/system-health/agent-strand-census.ts",
          "dimension": "source",
          "acceptedSha256": "f90607aafce701501836475b2f328eedc80d50eb620d2ba7b5555378908cf284",
          "currentSha256": "f90607aafce701501836475b2f328eedc80d50eb620d2ba7b5555378908cf284",
          "matches": true
        },
        {
          "path": "packages/operator-core/lib/system-health/compute.ts",
          "dimension": "source",
          "acceptedSha256": "529241e60ae0bbbbba53942104ffb5ee657d440d468f95485130c16ab65e5909",
          "currentSha256": "caabb259b0a63fc5cb522c926ee52ed8f39185a07cf6c9e332db9ed68c031d75",
          "matches": false
        },
        {
          "path": "packages/operator-core/lib/system-health/liveness-alarm.ts",
          "dimension": "source",
          "acceptedSha256": "674c3b2ef1e4c01843aef5b382951c1f59c5c0db36b0c9fbd7f0dbe634292b39",
          "currentSha256": "f46b54aebc449cf0616ae0a457924cb59fcac18d724e845fb0f3af7628b4853f",
          "matches": false
        },
        {
          "path": "packages/operator-core/test/isolated-integration-proof.ts",
          "dimension": "source",
          "acceptedSha256": "f83062e0b241b972db751ea5fddcb64e6b4f52db001f7fbfaab1c400cd140dba",
          "currentSha256": "62dd3348dd79c446af03397d5b17eadc7bd611cfb360f1089bce55714b84eae1",
          "matches": false
        },
        {
          "path": "packages/operator-core/test/liveness-alarm-http-fixture.ts",
          "dimension": "source",
          "acceptedSha256": "0c827e616987ffc5c85e32d8e8784213a8b63f8a1137b7906c006352248b7b1a",
          "currentSha256": "111e94ed9fb373abb4376cfae0fde6016770359fbf74d6aee6eb9739614a3f52",
          "matches": false
        },
        {
          "path": "packages/operator-core/test/private-http-workspace-preflight.ts",
          "dimension": "source",
          "acceptedSha256": "91473d3ec52d4672806c53377210e45dea8f5f7b4463d4a898fbf4fb22d63c16",
          "currentSha256": "4e1b727cadbf96a4f53ba2f20635bea0cbcc429b7babb6996552726044c03991",
          "matches": false
        },
        {
          "path": "scripts/lib/isolated-runtime-start.mjs",
          "dimension": "source",
          "acceptedSha256": "f604dc115a6f22e3d84a1b9ad332d89f615d418f751ef20d3bcbc021ea32033d",
          "currentSha256": "f604dc115a6f22e3d84a1b9ad332d89f615d418f751ef20d3bcbc021ea32033d",
          "matches": true
        },
        {
          "path": "scripts/with-test-pg.mjs",
          "dimension": "source",
          "acceptedSha256": "d2ed7c124b8cba57303f8350b0d942df2a807d68409d1ac11fad7cb39054334b",
          "currentSha256": "c5b091686531409443a86b582dfd2f9c465a8b9d7055c752354df490be87f750",
          "matches": false
        },
        {
          "path": "packages/operator-core/lib/system-health/liveness-alarm-current-build.e2e.test.ts",
          "dimension": "test",
          "acceptedSha256": "cc2e7abffb24f45eed27e539a98a3ebf1100ffebaf02b7f0aa39e2e934fcc96f",
          "currentSha256": "f62bf14b6ae06d361333052e888d578f04a04e255a1b722c05ad493d8cd2f2f6",
          "matches": false
        },
        {
          "path": "packages/operator-core/test/liveness-alarm-http-fixture.ts",
          "dimension": "fixture",
          "acceptedSha256": "0c827e616987ffc5c85e32d8e8784213a8b63f8a1137b7906c006352248b7b1a",
          "currentSha256": "111e94ed9fb373abb4376cfae0fde6016770359fbf74d6aee6eb9739614a3f52",
          "matches": false
        },
        {
          "path": "packages/operator-core/test/private-http-workspace-preflight.ts",
          "dimension": "fixture",
          "acceptedSha256": "91473d3ec52d4672806c53377210e45dea8f5f7b4463d4a898fbf4fb22d63c16",
          "currentSha256": "4e1b727cadbf96a4f53ba2f20635bea0cbcc429b7babb6996552726044c03991",
          "matches": false
        }
      ]
    },
    {
      "bar": "R-5",
      "bindingId": 38797,
      "files": [
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "dimension": "source",
          "acceptedSha256": "dc5ced7bb3da2fcd206a05bcd7069ae9e4b5ca8e9b35333fa5b551ea69290fb7",
          "currentSha256": "313a4bab2c627f22fd3dfc23c365768d2bb5d010e5c25274c53c7a1ba60b9efc",
          "matches": false
        },
        {
          "path": "apps/operator/lib/psu-pty-host-turn.integration.test.ts",
          "dimension": "test",
          "acceptedSha256": "38cb01cb83407664941223dc6070a5ba3a9ffd5bca8e12685668f90638bb011d",
          "currentSha256": "2db40d970a97aa3cecf31956d0ff5506d6acdee917df6fc73663263a3bd51e5b",
          "matches": false
        }
      ]
    },
    {
      "bar": "R-5",
      "bindingId": 38798,
      "files": [
        {
          "path": "apps/operator/scripts/psu-pty-host.mjs",
          "dimension": "source",
          "acceptedSha256": "dc5ced7bb3da2fcd206a05bcd7069ae9e4b5ca8e9b35333fa5b551ea69290fb7",
          "currentSha256": "313a4bab2c627f22fd3dfc23c365768d2bb5d010e5c25274c53c7a1ba60b9efc",
          "matches": false
        },
        {
          "path": "apps/operator/lib/psu-pty-host-turn.integration.test.ts",
          "dimension": "test",
          "acceptedSha256": "38cb01cb83407664941223dc6070a5ba3a9ffd5bca8e12685668f90638bb011d",
          "currentSha256": "2db40d970a97aa3cecf31956d0ff5506d6acdee917df6fc73663263a3bd51e5b",
          "matches": false
        }
      ]
    }
  ],
  "r5Run": {
    "ok": false,
    "runId": "0d4c5b97-0d2d-430a-b08d-bb9c8dc203ec",
    "root": "/home/marsh-office/papercupai-workspace/papercusp",
    "error": "timeout",
    "timeoutMs": 25000,
    "hint": "hit the 25s foreground cap (held below the ~55s MCP transport limit so you get this instead of an opaque CONNECTION_CLOSED).  — ⚠ CLAMPED: you requested 900s but the effective budget was 25s, the foreground ceiling kept below the ~55s MCP transport cap so this returns a real error instead of an opaque request_timeout. The deadline you set was never in force — do not read this as your budget being exhausted, and re-running with a larger timeoutSec will NOT buy more time.To bind this evidence, call evidenceBundle.recovery (testing:run { recoverEvidence }) now: it waits up to 30s for the detached run and binds in the same call; skip testing:run-status polling. ",
    "routerOutput": "edAt=2026-10-15T00:48:17.954Z\n  HEAD         : d6b54a74ce\n  tested files : apps/operator/lib/psu-pty-host.integration.test.ts  [clean]\n                 apps/operator/lib/psu-pty-host-turn.integration.test.ts  [clean]\n  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here\nROUTE cwd=apps/operator config=vitest.integration.config.ts\n  requested lib/psu-pty-host.integration.test.ts\n  requested lib/psu-pty-host-turn.integration.test.ts\nTEST_FILE_LIST_PROGRESS state=started cwd=\"apps/operator\" elapsedMs=12 capturedBytes=0 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=pending signal=pending\nTEST_FILE_LIST_PROGRESS state=finished cwd=\"apps/operator\" elapsedMs=2708 capturedBytes=685 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=0 signal=none\n  matched lib/psu-pty-host-turn.integration.test.ts\n  matched lib/psu-pty-host.integration.test.ts\nTEST_FILE_PROGRESS state=started cwd=\"apps/operator\" elapsedMs=12 capturedBytes=0 completedFiles=[] pendingFiles=[\"lib/psu-pty-host-turn.integration.test.ts\",\"lib/psu-pty-host.integration.test.ts\"] timeoutMs=22500 exitStatus=pending signal=pending\nTEST_FILE_PROGRESS state=running cwd=\"apps/operator\" elapsedMs=10013 capturedBytes=3815 completedFiles=[] pendingFiles=[\"lib/psu-pty-host-turn.integration.test.ts\",\"lib/psu-pty-host.integration.test.ts\"] timeoutMs=22500 exitStatus=pending signal=pending\nTEST_FILE_PROGRESS state=running cwd=\"apps/operator\" elapsedMs=20013 capturedBytes=4620 completedFiles=[] pendingFiles=[\"lib/psu-pty-host-turn.integration.test.ts\",\"lib/psu-pty-host.integration.test.ts\"] timeoutMs=22500 exitStatus=pending signal=pending\nTEST_FILE_PROGRESS state=parent-sigterm cwd=\"apps/operator\" elapsedMs=20352 capturedBytes=4620 completedFiles=[] pendingFiles=[\"lib/psu-pty-host-turn.integration.test.ts\",\"lib/psu-pty-host.integration.test.ts\"] timeoutMs=22500 exitStatus=pending signal=pending\n",
    "detachedRunId": "a239daa9-3140-412d-815b-9c022c1c595c",
    "detachedDurable": true,
    "rootSource": "requested",
    "evidenceBundle": {
      "status": "incomplete",
      "verificationFingerprint": null,
      "acceptance": "requires-review",
      "message": "The foreground test run timed out. Evidence remains pending until recovery reconciles the detached run with the test ledger.",
      "rows": [
        {
          "specId": "AUTO-BAR-R-5-P-005",
          "specRevision": 3,
          "evidenceRef": "test-run-group:0d4c5b97-0d2d-430a-b08d-bb9c8dc203ec:0",
          "testRunId": null,
          "ledgerRunGroupId": null,
          "phase": "pending",
          "outcome": "unknown"
        },
        {
          "specId": "AUTO-BAR-R-5-P-005",
          "specRevision": 3,
          "evidenceRef": "test-run-group:0d4c5b97-0d2d-430a-b08d-bb9c8dc203ec:1",
          "testRunId": null,
          "ledgerRunGroupId": null,
          "phase": "pending",
          "outcome": "unknown"
        }
      ],
      "total": 2,
      "omitted": 0,
      "readRef": {
        "tool": "plans:get-spec-evidence",
        "args": {
          "harness": "papercusp",
          "slug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
          "workItemIds": [
            "WI-6554700010008887"
          ],
          "evidenceRefs": [
            "test-run-group:0d4c5b97-0d2d-430a-b08d-bb9c8dc203ec:0",
            "test-run-group:0d4c5b97-0d2d-430a-b08d-bb9c8dc203ec:1"
          ]
        }
      },
      "recovery": {
        "tool": "testing:run",
        "args": {
          "harness": "papercusp",
          "recoverEvidence": {
            "workItemId": "WI-6554700010008887",
            "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
            "originRunId": "0d4c5b97-0d2d-430a-b08d-bb9c8dc203ec",
            "runId": "a239daa9-3140-412d-815b-9c022c1c595c"
          }
        }
      }
    },
    "phaseTimingsMs": {
      "preflightMs": 11.54,
      "provenanceMs": 0,
      "preparationMs": 578.55,
      "admissionWaitMs": 63.13,
      "routerExecutionMs": 27615.28,
      "ledgerIdReadbackMs": 0.11,
      "finalizationMs": 1.13,
      "totalHandlerMs": 30213.15
    }
  },
  "r5Recovery": {
    "ok": true,
    "mode": "evidence-recovery",
    "evidenceBundle": {
      "status": "recorded",
      "verificationFingerprint": null,
      "acceptance": "requires-review",
      "rows": [
        {
          "specId": "AUTO-BAR-R-5-P-005",
          "specRevision": 3,
          "evidenceRef": "test-run-group:0d4c5b97-0d2d-430a-b08d-bb9c8dc203ec:1",
          "testRunId": 21248970,
          "ledgerRunGroupId": "a239daa9-3140-412d-815b-9c022c1c595c",
          "phase": "source-changed",
          "outcome": "pass",
          "bindingStatus": "created"
        },
        {
          "specId": "AUTO-BAR-R-5-P-005",
          "specRevision": 3,
          "evidenceRef": "test-run-group:0d4c5b97-0d2d-430a-b08d-bb9c8dc203ec:0",
          "testRunId": 21248969,
          "ledgerRunGroupId": "a239daa9-3140-412d-815b-9c022c1c595c",
          "phase": "source-changed",
          "outcome": "pass",
          "bindingStatus": "created"
        }
      ],
      "total": 2,
      "omitted": 0,
      "readRef": {
        "tool": "plans:get-spec-evidence",
        "args": {
          "harness": "papercusp",
          "slug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
          "workItemIds": [
            "WI-6554700010008887"
          ],
          "evidenceRefs": [
            "test-run-group:0d4c5b97-0d2d-430a-b08d-bb9c8dc203ec:1",
            "test-run-group:0d4c5b97-0d2d-430a-b08d-bb9c8dc203ec:0"
          ]
        }
      },
      "pendingRetirement": {
        "status": "complete",
        "retiredCount": 2,
        "bindingIds": [
          45626,
          45627
        ],
        "omitted": 0,
        "failures": [],
        "failuresOmitted": 0
      },
      "detachedRunStatus": {
        "runId": "a239daa9-3140-412d-815b-9c022c1c595c",
        "status": "pass",
        "exitCode": 0,
        "finishedAt": 1792025376543
      },
      "recovery": {
        "tool": "testing:run",
        "args": {
          "harness": "papercusp",
          "recoverEvidence": {
            "workItemId": "WI-6554700010008887",
            "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
            "originRunId": "0d4c5b97-0d2d-430a-b08d-bb9c8dc203ec",
            "runId": "a239daa9-3140-412d-815b-9c022c1c595c"
          }
        }
      },
      "recoveryWait": {
        "limitMs": 30000,
        "waitedMs": 2056,
        "ledgerWaitedMs": 10,
        "outcome": "terminal"
      }
    }
  },
  "r5Hold": {
    "holder": "su-b747a019-6d1b-4d1b-96a9-24a4f2b09fff",
    "path": "apps/operator/scripts/psu-pty-host.mjs",
    "intent": "Fix Codex native-session reanchor on non-carry recycle before managed carry delivery",
    "message": "coord-send-36a7f0e9f77363a8eaf49178378e83f42a5e2784428e80290a8ac45e60e5d3d4"
  },
  "r12Ledger": {
    "count": 1,
    "total": 1,
    "truncatedByLimit": false,
    "latestPerFile": false,
    "effectiveSourceFilter": "source <> 'mutation-probe' (default row-list exclusion)",
    "omittedBySourceFilter": 0,
    "runs": [
      {
        "id": 21249005,
        "workspaceId": "papercusp-workspace",
        "harnessSlug": "papercusp",
        "root": "/home/marsh-office/papercupai-workspace/papercusp",
        "executionDetails": {
          "root": "/home/marsh-office/papercupai-workspace/papercusp",
          "failed": 0,
          "passed": 1,
          "skipped": 3,
          "filePath": "packages/operator-core/lib/system-health/liveness-alarm-current-build.e2e.test.ts",
          "commitSha": "3d2e1fd122eb4823c6b044472d5d898b012c14a8",
          "testLayer": "e2e",
          "runGroupId": "48332fac-6490-457e-8022-59b19f531a0c",
          "harnessSlug": "papercusp",
          "workspaceId": "papercusp-workspace",
          "mutationPhase": null,
          "schemaVersion": 1,
          "worktreeDirty": true,
          "testNamePattern": "keeps a request-worker wedged alarm standing across restart and resolves only a measured recovery",
          "collectionFailed": false,
          "passedCaseTitles": [
            "keeps a request-worker wedged alarm standing across restart and resolves only a measured recovery"
          ],
          "worktreeDirtyReason": "HEAD moved 0a2fb91eb036 -> 3d2e1fd122eb",
          "runtimeEnvironmentAfterCaptureStatus": "not-configured",
          "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
        },
        "filePath": "packages/operator-core/lib/system-health/liveness-alarm-current-build.e2e.test.ts",
        "status": "pass",
        "framework": "vitest",
        "startedAt": "2026-10-15T00:49:14.265Z",
        "finishedAt": "2026-10-15T00:53:47.257Z",
        "durationMs": 272992,
        "commitSha": "3d2e1fd122eb4823c6b044472d5d898b012c14a8",
        "runGroupId": "48332fac-6490-457e-8022-59b19f531a0c",
        "source": "local",
        "branch": "staging",
        "outputTail": null,
        "loopLagP95Ms": null,
        "rssMb": 78,
        "saturationSuspect": null,
        "worktreeDirty": true,
        "isScratchConfig": false,
        "cases": [
          {
            "caseKey": "keeps a request-worker wedged alarm standing across restart and resolves only a measured recovery",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 272984,
            "errorTail": null
          },
          {
            "caseKey": "keeps one accountable hosted reliability alarm across restart and unknown evidence, then resolves witnessed recovery",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "delivers one connector-loss alarm and resolves reconnection across restart and unknown evidence",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          },
          {
            "caseKey": "delivers one Papercusp-owned spend alarm and resolves a measured budget recovery",
            "occurrence": 1,
            "status": "skip",
            "durationMs": null,
            "errorTail": null
          }
        ]
      }
    ]
  },
  "r12OriginalProof": {
    "schemaVersion": "parked-fire54-original-r12-runtime-proof-v1",
    "observedAt": "2026-10-15T01:00:12.917434+00:00",
    "runId": "20261015T004914Z-1242834",
    "testRunId": 21249005,
    "sourcePath": "/home/marsh-office/.local/state/verification-harness/isolated-integration/20261015T004914Z-1242834",
    "originalArtifacts": {
      "result.json": {
        "sha256": "5898fd38b9168020700b20310978c529c7b5bab665aa2e00485f51acb6bccc82",
        "content": {
          "schemaVersion": 1,
          "harness": "isolated-integration",
          "runId": "20261015T004914Z-1242834",
          "evidenceDir": "/home/marsh-office/.local/state/verification-harness/isolated-integration/20261015T004914Z-1242834",
          "selection": {
            "only": null,
            "from": null
          },
          "reuseFromRunId": null,
          "preflight": null,
          "phases": [
            {
              "phase": "prepare",
              "evidenceDir": "/home/marsh-office/.local/state/verification-harness/isolated-integration/20261015T004914Z-1242834/phases/prepare",
              "startedAt": "2026-10-15T00:49:14.874Z",
              "endedAt": "2026-10-15T00:49:31.283Z",
              "elapsedMs": 16409,
              "status": "passed",
              "step": null,
              "reasonCode": null
            },
            {
              "phase": "execute",
              "evidenceDir": "/home/marsh-office/.local/state/verification-harness/isolated-integration/20261015T004914Z-1242834/phases/execute",
              "startedAt": "2026-10-15T00:49:31.285Z",
              "endedAt": "2026-10-15T00:53:45.982Z",
              "elapsedMs": 254697,
              "status": "passed",
              "step": null,
              "reasonCode": null
            },
            {
              "phase": "teardown",
              "evidenceDir": "/home/marsh-office/.local/state/verification-harness/isolated-integration/20261015T004914Z-1242834/phases/teardown",
              "startedAt": "2026-10-15T00:53:46.725Z",
              "endedAt": "2026-10-15T00:53:46.728Z",
              "elapsedMs": 3,
              "status": "passed",
              "step": null,
              "reasonCode": null
            }
          ],
          "verdict": "pass",
          "firstFailure": null,
          "startedAt": "2026-10-15T00:49:14.872Z",
          "endedAt": "2026-10-15T00:53:46.796Z"
        }
      },
      "phases/prepare/source.json": {
        "sha256": "ae53368712eef506deea5c586cabe923a23620f69387c8e5c748b188f0283fe5",
        "content": {
          "schemaVersion": 1,
          "runId": "20261015T004914Z-1242834",
          "sourceCommit": "0a2fb91eb03652780807a1bcb5ffbc90e75c9eee",
          "repoRoot": "/home/marsh-office/papercupai-workspace/papercusp",
          "filePath": "packages/operator-core/lib/system-health/liveness-alarm-current-build.e2e.test.ts",
          "runGroupId": "48332fac-6490-457e-8022-59b19f531a0c",
          "workspaceId": "papercusp-workspace",
          "harnessSlug": "papercusp",
          "files": [
            {
              "path": "apps/operator/bin/bundle-host.sh",
              "sha256": "cacd91c424cbc9afaea5742ea5c636606abea1469ef270ca04bd8924792c6dfe",
              "gitSha256": "cacd91c424cbc9afaea5742ea5c636606abea1469ef270ca04bd8924792c6dfe"
            },
            {
              "path": "apps/operator/bin/hono-host.ts",
              "sha256": "611708b9bd17e8464a84168251b918f8991f4bb270bf34e67921f8bea4efd98d",
              "gitSha256": "611708b9bd17e8464a84168251b918f8991f4bb270bf34e67921f8bea4efd98d"
            },
            {
              "path": "packages/operator-core/lib/agent-tools/coordination/escalations.ts",
              "sha256": "2ce6c37f1b9fb80b74402c6f77feca45a5dc49b97c370daed70796386b54bf52",
              "gitSha256": "2ce6c37f1b9fb80b74402c6f77feca45a5dc49b97c370daed70796386b54bf52"
            },
            {
              "path": "packages/operator-core/lib/build-info.ts",
              "sha256": "6d271f5721a0d47c68fa8f42996a34f7b48fe4c06e414285a3f7fe36bdc44a50",
              "gitSha256": "6d271f5721a0d47c68fa8f42996a34f7b48fe4c06e414285a3f7fe36bdc44a50"
            },
            {
              "path": "packages/operator-core/lib/derived-reads/shared-snapshot.ts",
              "sha256": "ab154eea455bfe4290e65f664456a15360cf4151e3a6acfcc7bb9ed666c22826",
              "gitSha256": "ab154eea455bfe4290e65f664456a15360cf4151e3a6acfcc7bb9ed666c22826"
            },
            {
              "path": "packages/operator-core/lib/severe-event-owner.ts",
              "sha256": "2c59fb583ed0e16abffb543fcf00f2099d2b524786dc456dac78f79648e5cbb2",
              "gitSha256": "2c59fb583ed0e16abffb543fcf00f2099d2b524786dc456dac78f79648e5cbb2"
            },
            {
              "path": "packages/operator-core/lib/system-health/agent-strand-census.ts",
              "sha256": "f90607aafce701501836475b2f328eedc80d50eb620d2ba7b5555378908cf284",
              "gitSha256": "f90607aafce701501836475b2f328eedc80d50eb620d2ba7b5555378908cf284"
            },
            {
              "path": "packages/operator-core/lib/system-health/compute.ts",
              "sha256": "caabb259b0a63fc5cb522c926ee52ed8f39185a07cf6c9e332db9ed68c031d75",
              "gitSha256": "caabb259b0a63fc5cb522c926ee52ed8f39185a07cf6c9e332db9ed68c031d75"
            },
            {
              "path": "packages/operator-core/lib/system-health/liveness-alarm-current-build.e2e.test.ts",
              "sha256": "f62bf14b6ae06d361333052e888d578f04a04e255a1b722c05ad493d8cd2f2f6",
              "gitSha256": "f62bf14b6ae06d361333052e888d578f04a04e255a1b722c05ad493d8cd2f2f6"
            },
            {
              "path": "packages/operator-core/lib/system-health/liveness-alarm.ts",
              "sha256": "f46b54aebc449cf0616ae0a457924cb59fcac18d724e845fb0f3af7628b4853f",
              "gitSha256": "f46b54aebc449cf0616ae0a457924cb59fcac18d724e845fb0f3af7628b4853f"
            },
            {
              "path": "packages/operator-core/lib/workspace-host/observability-store.ts",
              "sha256": "a5caa034e552bbe282b1fd8ba1536ae9d2a081977be1f74c796ed62b15872bf5",
              "gitSha256": "a5caa034e552bbe282b1fd8ba1536ae9d2a081977be1f74c796ed62b15872bf5"
            },
            {
              "path": "packages/operator-core/test/isolated-integration-proof.ts",
              "sha256": "62dd3348dd79c446af03397d5b17eadc7bd611cfb360f1089bce55714b84eae1",
              "gitSha256": "62dd3348dd79c446af03397d5b17eadc7bd611cfb360f1089bce55714b84eae1"
            },
            {
              "path": "packages/operator-core/test/liveness-alarm-http-fixture.ts",
              "sha256": "111e94ed9fb373abb4376cfae0fde6016770359fbf74d6aee6eb9739614a3f52",
              "gitSha256": "111e94ed9fb373abb4376cfae0fde6016770359fbf74d6aee6eb9739614a3f52"
            },
            {
              "path": "packages/operator-core/test/private-http-workspace-preflight.ts",
              "sha256": "4e1b727cadbf96a4f53ba2f20635bea0cbcc429b7babb6996552726044c03991",
              "gitSha256": "4e1b727cadbf96a4f53ba2f20635bea0cbcc429b7babb6996552726044c03991"
            },
            {
              "path": "scripts/lib/isolated-runtime-start.mjs",
              "sha256": "f604dc115a6f22e3d84a1b9ad332d89f615d418f751ef20d3bcbc021ea32033d",
              "gitSha256": "f604dc115a6f22e3d84a1b9ad332d89f615d418f751ef20d3bcbc021ea32033d"
            },
            {
              "path": "scripts/with-test-pg.mjs",
              "sha256": "c5b091686531409443a86b582dfd2f9c465a8b9d7055c752354df490be87f750",
              "gitSha256": "cb74356a8be58e4183c4f1e08e41a9bddab573abe1194647163e5aa2ad22db46"
            },
            {
              "path": "scripts/lib/with-test-pg-cleanup.mjs",
              "sha256": "37effd76e07e992646bd8192b93ead3ee7e865712de89d9eb733bdc1a8713b61",
              "gitSha256": "c0305bc98e6b150bdbe11fcc2d49968af665c64b16e72643113d625f66615789"
            }
          ],
          "parentObserver": {
            "database": "org_1ea437c623fc",
            "flush": {
              "written": 0,
              "failed": 0,
              "dropped": 0,
              "rejected": 0
            }
          }
        }
      },
      "phases/execute/lifecycle.json": {
        "sha256": "3a16685c257fba66e711b0a3d42a0112ea6a032ee5966e022ca9dcabce3183d2",
        "content": {
          "schemaVersion": 1,
          "runId": "20261015T004914Z-1242834",
          "host": "main-server-Precision-7865-Tower",
          "observedAt": "2026-10-15T00:50:26.756Z",
          "observer": {
            "pid": 1242834,
            "identity": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:81432151",
            "parentPid": 1239515
          },
          "supervisor": {
            "pid": 1262344,
            "identity": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:81434477",
            "parentPid": 1242834
          },
          "worker": {
            "pid": 1336609,
            "identity": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:81439996",
            "parentPid": 1262344
          },
          "database": {
            "pid": 1298569,
            "identity": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:81437144",
            "parentPid": 1262344
          },
          "argv": [
            "/home/marsh-office/.local/node25/bin/node",
            "--import",
            "/home/marsh-office/papercupai-workspace/papercusp/scripts/lib/isolated-runtime-start.mjs",
            "--import",
            "tsx",
            "/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/test/liveness-alarm-http-fixture.ts"
          ],
          "cwd": "/home/marsh-office/papercupai-workspace/papercusp",
          "workspace": "test-runtime-fbbde176-833",
          "runtimeRoot": "/tmp/pcv/papercusp-test-runtime-VyKAWr",
          "dataDir": "/tmp/pcv/papercusp-test-pg-3IT5Aa",
          "pgPort": 44523,
          "ended": {
            "kind": "isolated-runtime-end",
            "childPid": 1336609,
            "exitCode": 0,
            "signal": null,
            "runtimeRemoved": true,
            "pgDataRemoved": true,
            "observedAt": "2026-10-15T00:53:45.559Z"
          }
        }
      },
      "phases/execute/lifecycle-observation.json": {
        "sha256": "7a5385c6bd252453b7b7033c761ed9ce22a94f9663cbfd5999820c1f4c141756",
        "content": {
          "lifecycle": {
            "schemaVersion": 1,
            "runId": "20261015T004914Z-1242834",
            "host": "main-server-Precision-7865-Tower",
            "observedAt": "2026-10-15T00:50:26.756Z",
            "observer": {
              "pid": 1242834,
              "identity": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:81432151",
              "parentPid": 1239515
            },
            "supervisor": {
              "pid": 1262344,
              "identity": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:81434477",
              "parentPid": 1242834
            },
            "worker": {
              "pid": 1336609,
              "identity": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:81439996",
              "parentPid": 1262344
            },
            "database": {
              "pid": 1298569,
              "identity": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:81437144",
              "parentPid": 1262344
            },
            "argv": [
              "/home/marsh-office/.local/node25/bin/node",
              "--import",
              "/home/marsh-office/papercupai-workspace/papercusp/scripts/lib/isolated-runtime-start.mjs",
              "--import",
              "tsx",
              "/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/test/liveness-alarm-http-fixture.ts"
            ],
            "cwd": "/home/marsh-office/papercupai-workspace/papercusp",
            "workspace": "test-runtime-fbbde176-833",
            "runtimeRoot": "/tmp/pcv/papercusp-test-runtime-VyKAWr",
            "dataDir": "/tmp/pcv/papercusp-test-pg-3IT5Aa",
            "pgPort": 44523
          },
          "ended": {
            "kind": "isolated-runtime-end",
            "childPid": 1336609,
            "exitCode": 0,
            "signal": null,
            "runtimeRemoved": true,
            "pgDataRemoved": true,
            "observedAt": "2026-10-15T00:53:45.559Z"
          },
          "observationError": null
        }
      },
      "phases/execute/worker-result.json": {
        "sha256": "1a0e0e7841ee3ea25d7655cdfe53e783f53c6115cbb89de7dddcd6e89cbe1621",
        "content": {
          "code": 0,
          "signal": null,
          "timedOut": false,
          "timeoutPhase": null,
          "exitWaitTimedOut": false,
          "stdioDrainTimedOut": false,
          "error": null
        }
      }
    },
    "httpReceipts": [
      {
        "workspace": "test-runtime-fbbde176-833",
        "hostStopped": true,
        "signal": "agents-wedged",
        "threshold": 10,
        "belowThreshold": 9,
        "alarmCount": 1,
        "restartDedupCount": 1,
        "unknownPreserved": true,
        "sourceUnchanged": true,
        "sourceFingerprints": {
          "packages/operator-core/lib/system-health/liveness-alarm.ts": "f46b54aebc449cf0616ae0a457924cb59fcac18d724e845fb0f3af7628b4853f",
          "packages/operator-core/lib/system-health/agent-strand-census.ts": "f90607aafce701501836475b2f328eedc80d50eb620d2ba7b5555378908cf284",
          "packages/operator-core/lib/system-health/compute.ts": "caabb259b0a63fc5cb522c926ee52ed8f39185a07cf6c9e332db9ed68c031d75",
          "packages/operator-core/lib/derived-reads/shared-snapshot.ts": "ab154eea455bfe4290e65f664456a15360cf4151e3a6acfcc7bb9ed666c22826",
          "packages/operator-core/lib/agent-tools/coordination/escalations.ts": "2ce6c37f1b9fb80b74402c6f77feca45a5dc49b97c370daed70796386b54bf52",
          "packages/operator-core/lib/workspace-host/observability-store.ts": "a5caa034e552bbe282b1fd8ba1536ae9d2a081977be1f74c796ed62b15872bf5",
          "packages/operator-core/lib/severe-event-owner.ts": "2c59fb583ed0e16abffb543fcf00f2099d2b524786dc456dac78f79648e5cbb2",
          "apps/operator/bin/hono-host.ts": "611708b9bd17e8464a84168251b918f8991f4bb270bf34e67921f8bea4efd98d"
        },
        "bundleSha256": "465d744ea3ec1ea83f03e1f78f925a5f8abe090b23144951439a4df63e756926",
        "intervalMs": 500,
        "first": {
          "pid": 1484068,
          "identity": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:81456670",
          "health": {
            "ok": true,
            "service": "papercusp-operator",
            "sha": "6d66893ba7",
            "version": "0.0.1",
            "claimSpec": {
              "specVersion": "1.0",
              "revisionAdoption": [
                "first"
              ]
            },
            "ts": "2026-10-15T00:53:23.953Z"
          }
        },
        "second": {
          "pid": 1500373,
          "identity": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:81458149",
          "health": {
            "ok": true,
            "service": "papercusp-operator",
            "sha": "6d66893ba7",
            "version": "0.0.1",
            "claimSpec": {
              "specVersion": "1.0",
              "revisionAdoption": [
                "first"
              ]
            },
            "ts": "2026-10-15T00:53:37.113Z"
          }
        },
        "raised": {
          "to": [
            "human"
          ],
          "ts": "2026-10-15T00:53:24.463Z",
          "body": "Detected by the request-path infra-liveness alarm (R4-3/R4-8) — it runs on a request worker, independent of the background routine engine, so it fires even when that engine is frozen (the failure that blinds the in-engine watchdog). Signal: agents-wedged. Workspace: test-runtime-fbbde176-833.",
          "from": "system:infra-liveness-alarm",
          "kind": "escalation",
          "msg_id": "mv8trxwz-0000-6ba37ae5b8604c87ab0a7525eb241567",
          "summary": "[infra-liveness] 10 agent session(s) cannot take a turn (quota-blocked 10; threshold 10) — wakes to them land and nothing happens. coord:presence reports each as suspect with its wedged class; a single class at this scale is one shared cause (a quota-walled account, a dead credential, a launcher fault). e.g. ",
          "resolved": null,
          "severity": "blocker",
          "dedupKind": "infra-liveness",
          "lastSeenTs": "2026-10-15T00:53:24.463Z",
          "repeatCount": 1,
          "needsHumanRoute": true,
          "subjectSignature": "agents-wedged",
          "livenessSignature": "agents-wedged",
          "agentStrandObservation": {
            "wedged": 10,
            "runtime": {
              "pid": 1484068,
              "sha": "6d66893ba7",
              "version": "0.0.1"
            },
            "stranded": 0,
            "thresholds": {
              "wedged": 10,
              "stranded": 5
            },
            "observedAtMs": 1792025604109,
            "snapshotAtMs": 1792025593151,
            "wedgedByClass": {
              "auth-blocked": 0,
              "quota-blocked": 10,
              "unbound-successor": 0,
              "pending-turn-stuck": 0
            }
          }
        },
        "recovered": {
          "by": "system:infra-liveness-alarm",
          "to": [
            "system:infra-liveness-alarm"
          ],
          "ts": "2026-10-15T00:53:41.487Z",
          "from": "system:infra-liveness-alarm",
          "kind": "escalation_resolved",
          "note": "infra-liveness signal 'agents-wedged' cleared (condition recovered) — observed coordination agentStrand wedged=9 (quota-blocked 9; alarm threshold >= 10)",
          "choice": "auto-resolved",
          "msg_id": "res-mv8trxwz-0000-6ba37ae5b8604c87ab0a7525eb241567",
          "summary": "resolved: auto-resolved",
          "generation": 0,
          "related_msg_id": "mv8trxwz-0000-6ba37ae5b8604c87ab0a7525eb241567"
        }
      }
    ],
    "currentSourceComparison": [
      {
        "path": "apps/operator/bin/bundle-host.sh",
        "recorded": "cacd91c424cbc9afaea5742ea5c636606abea1469ef270ca04bd8924792c6dfe",
        "current": "cacd91c424cbc9afaea5742ea5c636606abea1469ef270ca04bd8924792c6dfe",
        "matches": true
      },
      {
        "path": "apps/operator/bin/hono-host.ts",
        "recorded": "611708b9bd17e8464a84168251b918f8991f4bb270bf34e67921f8bea4efd98d",
        "current": "611708b9bd17e8464a84168251b918f8991f4bb270bf34e67921f8bea4efd98d",
        "matches": true
      },
      {
        "path": "packages/operator-core/lib/agent-tools/coordination/escalations.ts",
        "recorded": "2ce6c37f1b9fb80b74402c6f77feca45a5dc49b97c370daed70796386b54bf52",
        "current": "2ce6c37f1b9fb80b74402c6f77feca45a5dc49b97c370daed70796386b54bf52",
        "matches": true
      },
      {
        "path": "packages/operator-core/lib/build-info.ts",
        "recorded": "6d271f5721a0d47c68fa8f42996a34f7b48fe4c06e414285a3f7fe36bdc44a50",
        "current": "6d271f5721a0d47c68fa8f42996a34f7b48fe4c06e414285a3f7fe36bdc44a50",
        "matches": true
      },
      {
        "path": "packages/operator-core/lib/derived-reads/shared-snapshot.ts",
        "recorded": "ab154eea455bfe4290e65f664456a15360cf4151e3a6acfcc7bb9ed666c22826",
        "current": "ab154eea455bfe4290e65f664456a15360cf4151e3a6acfcc7bb9ed666c22826",
        "matches": true
      },
      {
        "path": "packages/operator-core/lib/severe-event-owner.ts",
        "recorded": "2c59fb583ed0e16abffb543fcf00f2099d2b524786dc456dac78f79648e5cbb2",
        "current": "2c59fb583ed0e16abffb543fcf00f2099d2b524786dc456dac78f79648e5cbb2",
        "matches": true
      },
      {
        "path": "packages/operator-core/lib/system-health/agent-strand-census.ts",
        "recorded": "f90607aafce701501836475b2f328eedc80d50eb620d2ba7b5555378908cf284",
        "current": "f90607aafce701501836475b2f328eedc80d50eb620d2ba7b5555378908cf284",
        "matches": true
      },
      {
        "path": "packages/operator-core/lib/system-health/compute.ts",
        "recorded": "caabb259b0a63fc5cb522c926ee52ed8f39185a07cf6c9e332db9ed68c031d75",
        "current": "caabb259b0a63fc5cb522c926ee52ed8f39185a07cf6c9e332db9ed68c031d75",
        "matches": true
      },
      {
        "path": "packages/operator-core/lib/system-health/liveness-alarm-current-build.e2e.test.ts",
        "recorded": "f62bf14b6ae06d361333052e888d578f04a04e255a1b722c05ad493d8cd2f2f6",
        "current": "f62bf14b6ae06d361333052e888d578f04a04e255a1b722c05ad493d8cd2f2f6",
        "matches": true
      },
      {
        "path": "packages/operator-core/lib/system-health/liveness-alarm.ts",
        "recorded": "f46b54aebc449cf0616ae0a457924cb59fcac18d724e845fb0f3af7628b4853f",
        "current": "f46b54aebc449cf0616ae0a457924cb59fcac18d724e845fb0f3af7628b4853f",
        "matches": true
      },
      {
        "path": "packages/operator-core/lib/workspace-host/observability-store.ts",
        "recorded": "a5caa034e552bbe282b1fd8ba1536ae9d2a081977be1f74c796ed62b15872bf5",
        "current": "a5caa034e552bbe282b1fd8ba1536ae9d2a081977be1f74c796ed62b15872bf5",
        "matches": true
      },
      {
        "path": "packages/operator-core/test/isolated-integration-proof.ts",
        "recorded": "62dd3348dd79c446af03397d5b17eadc7bd611cfb360f1089bce55714b84eae1",
        "current": "62dd3348dd79c446af03397d5b17eadc7bd611cfb360f1089bce55714b84eae1",
        "matches": true
      },
      {
        "path": "packages/operator-core/test/liveness-alarm-http-fixture.ts",
        "recorded": "111e94ed9fb373abb4376cfae0fde6016770359fbf74d6aee6eb9739614a3f52",
        "current": "111e94ed9fb373abb4376cfae0fde6016770359fbf74d6aee6eb9739614a3f52",
        "matches": true
      },
      {
        "path": "packages/operator-core/test/private-http-workspace-preflight.ts",
        "recorded": "4e1b727cadbf96a4f53ba2f20635bea0cbcc429b7babb6996552726044c03991",
        "current": "4e1b727cadbf96a4f53ba2f20635bea0cbcc429b7babb6996552726044c03991",
        "matches": true
      },
      {
        "path": "scripts/lib/isolated-runtime-start.mjs",
        "recorded": "f604dc115a6f22e3d84a1b9ad332d89f615d418f751ef20d3bcbc021ea32033d",
        "current": "f604dc115a6f22e3d84a1b9ad332d89f615d418f751ef20d3bcbc021ea32033d",
        "matches": true
      },
      {
        "path": "scripts/with-test-pg.mjs",
        "recorded": "c5b091686531409443a86b582dfd2f9c465a8b9d7055c752354df490be87f750",
        "current": "c5b091686531409443a86b582dfd2f9c465a8b9d7055c752354df490be87f750",
        "matches": true
      },
      {
        "path": "scripts/lib/with-test-pg-cleanup.mjs",
        "recorded": "37effd76e07e992646bd8192b93ead3ee7e865712de89d9eb733bdc1a8713b61",
        "current": "37effd76e07e992646bd8192b93ead3ee7e865712de89d9eb733bdc1a8713b61",
        "matches": true
      }
    ],
    "limits": [
      "Working-tree run; parent ledger worktreeDirty true because HEAD moved.",
      "Reporter runtime receipts missing with filtered skips; owned EI-26005080504809800.",
      "Not a new accepted binding, current adequate scorecard or all-fix runtime anchor."
    ]
  },
  "receiptBug": "EI-26005080504809800",
  "limits": [
    "No current R5 acceptance: two passing rows are source-changed.",
    "R12 original behavior PASS and17source files unchanged at read; ledger lacks receipts, worktreeDirty/filtered scope. No new binding/scorecard acceptance.",
    "R13 pending owner scope answer; no amendment or historical cohort changes.",
    "Original root961 callback omission unverified; later connection-reset release failure separate.",
    "All-final-fix runtime anchor and actual24hR14 remain absent."
  ]
}
