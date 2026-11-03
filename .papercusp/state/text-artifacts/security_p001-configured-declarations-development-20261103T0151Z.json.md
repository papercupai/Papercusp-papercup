---
rel_path: "security/p001-configured-declarations-development-20261103T0151Z.json"
updated_at: 1793670645381
_body: "content"
---

{
  "schema": "p001-configured-declarations-development-v1",
  "plan": "app-security-runtime-boundaries-and-defense-in-depth-2026-10-31",
  "workItem": "WI-6554700010044289",
  "producer": "su-9aa0bac1-57ab-408e-a009-fd2b58012aa0",
  "populationComplete": false,
  "closureAccepted": false,
  "executionAdmitted": false,
  "evidenceScope": "Working/committed-source development only; current SHA pins are read after runs, not a measurement of all imported loaded bytes. No runtime, tuple, qualification or shipment acceptance.",
  "change": "Extend existing cached plugin census with per-declaration tools/actions/routines/reactions and opaque apiRoutes; preserve excluded/error/shadowed states, duplicate names, detached metadata and UNKNOWN reachability/effect/artifact/applicability. Owning HTTP census includes these only in declaredSurfaces.",
  "verification": {
    "initialNative18780": "EXIT1/DRAINED: new hostile getter fixture lacked cleanup; 27 later beforeEach failures,6PASS/1preexistingSKIP. Separate host group4PASS0SKIP.",
    "correctedNative3004": "EXIT1/DRAINED:32PASS1FAIL1preexistingSKIP. Existing first reaction registration60s timeout; new declaration test passed. Root cause UNKNOWN, owned EI-27729171501826623.",
    "focusedNative70198": "EXIT0/DRAINED:4security-discovery casesPASS,30filtered/skipped. TestNamePattern=plugin host security discovery. childSubstituted11; not whole-file green.",
    "typesNative50992": "EXIT0/DRAINED:operator and operator-core scoped4files clean before final phase-diagnostic addition. No whole-project clean claim.",
    "finalDiagnosticTestTypes": "NOT RUN: native authority lookup1505ms failed closed before command launch. Needs scoped test-file typecheck after operator authority recovers."
  },
  "residue": [
    "EI-27729171501826623 first-reaction timeout root cause unknown; bounded Vitest onTestFailed stage history added to all withFixtureTool uses, not yet exercised by failing reaction diagnostic.",
    "All seven population closures UNKNOWN; retained preflight remains authority. No shards replayed.",
    "WI-6554700010045143 eligible outside-lineage review unresolved; no duplicate/force reviewer."
  ],
  "sourcePins": [
    {
      "path": "packages/operator-core/lib/plugin-host-runtime.ts",
      "sha256": "898266c2864624a3d2a0dd34576ec8c26c015479bc41369d2ed2057543b054a7"
    },
    {
      "path": "packages/operator-core/lib/plugin-host-runtime.test.ts",
      "sha256": "9a0c7e9fab545da9545ce27e58e8b10cb36c8d8cf86b32600204058a758ca24f"
    },
    {
      "path": "apps/operator/bin/host-handler.ts",
      "sha256": "7239b275a39ba1dcd2c66acdf87a5a1b573923fdbd81481a788892ed2bf131f6"
    },
    {
      "path": "apps/operator/bin/host-handler-http.test.ts",
      "sha256": "197fb2e92407756f41b389147bef000161e6e9b1e32b176e1facfbb891df206d"
    }
  ],
  "logs": [
    {
      "path": "/tmp/security-configured-declarations-20261103T0130Z.log",
      "sha256": "401a4481527ea0469c7c4d683a7337cef79fb1a3e5814b5a4afb19293088219d",
      "markers": [
        "      Tests  27 failed | 6 passed | 1 skipped (34)",
        "      Tests  4 passed (4)",
        "TEST_FILE_RESULT requested=2 executed=2 matched=2 status=failed head=dff60a859b uncommittedPaths=2/2 provenance=unknown startedAt=2026-11-03T01:29:50.782Z childSubstituted=0 childNoticeOffsetBytes=0 skippedTests=1"
      ]
    },
    {
      "path": "/tmp/security-configured-declarations-final-20261103T0140Z.log",
      "sha256": "b9fcd85dd19751789b2e5bb0c13b3d043c68316e0a6ec3a15102685fc94887b5",
      "markers": [
        "      Tests  1 failed | 32 passed | 1 skipped (34)",
        "TEST_FILE_RESULT requested=1 executed=1 matched=1 status=failed head=c48836397a uncommittedPaths=1/1 provenance=unknown startedAt=2026-11-03T01:38:58.570Z childSubstituted=0 childNoticeOffsetBytes=0 skippedTests=1"
      ]
    },
    {
      "path": "/tmp/security-configured-declarations-focused-20261103T0146Z.log",
      "sha256": "5847d6edb05590934b060eb2ce0eca24abf6f79d49c75ffdc26d5aa2a7aaaf68",
      "markers": [
        "      Tests  4 passed | 30 skipped (34)",
        "TEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed head=a7293376e6 uncommittedPaths=1/1 provenance=unknown startedAt=2026-11-03T01:47:36.511Z childSubstituted=11 childNoticeOffsetBytes=0 skippedTests=30"
      ]
    },
    {
      "path": "/tmp/security-configured-declarations-types-final-20261103T0140Z.log",
      "sha256": "3a1ba85a91b67329a30204e043933ca66d5bb53a6c83e393a393e8db6507cca6",
      "markers": [
        "LINT_TSC_RESULT label=operator scope=files exit=0 status=clean at=2026-11-03T01:40:42.223Z head=5c00668e6d",
        "LINT_TSC_RESULT label=operator-core scope=files exit=0 status=clean filesRoutedAway=2 at=2026-11-03T01:38:19.174Z head=c48836397a"
      ]
    }
  ]
}
