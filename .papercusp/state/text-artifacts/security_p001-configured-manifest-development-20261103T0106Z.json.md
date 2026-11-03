---
rel_path: "security/p001-configured-manifest-development-20261103T0106Z.json"
updated_at: 1793668080862
_body: "content"
---

{
  "schema": "p001-configured-manifest-development-proof-v1",
  "plan": "app-security-runtime-boundaries-and-defense-in-depth-2026-10-31",
  "workItem": "WI-6554700010044289",
  "producer": "su-9aa0bac1-57ab-408e-a009-fd2b58012aa0",
  "sourcePins": {
    "libs/generic/plugin-loader/src/loader.ts": "3681ab5bd4cfc2f6a5236d5ae65c687892c928d536d73938ba7fa97cfa0bd2c6",
    "libs/generic/plugin-loader/src/loader.test.ts": "a91867093afa57dcb458ddbaee73d53d17ad1c159ba11359816d487c002a67b7",
    "packages/plugin-loader/src/index.ts": "d5086e6f221eccb546cffecb5b563ce31f55d2ac4135cfa3e5e96465fb84d0e9",
    "packages/plugin-loader/src/loader.test.ts": "7c78d30b7ceb302a01b8d8f00b88edda4fe95a3609d6ecbef69c84c6ffc99ad7",
    "packages/operator-core/lib/plugin-host-runtime.ts": "bbce9dad9e2903b10747699a44b14fa536c0ef205d82a88f92ebf2545d63d47c",
    "packages/operator-core/lib/plugin-host-runtime.test.ts": "9de12f44f8dfcba9e1694aac542b693f0920c3705bd5be01cb92f5a7a2af2139"
  },
  "logs": [
    {
      "path": "/tmp/security-plugin-manifest-retention-20261103T0055Z.log",
      "sha256": "8697700b5a5705be9ef93c767e3ea02dce789d278355e97b28db570aa5efa38a",
      "markers": [
        "TEST_FILE_FINALIZATION {\"pid\":2691223,\"phase\":\"reporter-pg-timeout\",\"reporter\":\"test-runs\",\"holders\":0,\"inFlight\":1,\"closeRequested\":true,\"clientRequested\":true,\"closing\":false}",
        "TEST_FILE_RESULT requested=3 executed=3 matched=3 status=passed head=026a4557e5 uncommittedPaths=3/3 provenance=stamped startedAt=2026-11-03T00:56:40.042Z childSubstituted=6 childNoticeOffsetBytes=0 skippedTests=1 finalizationError=true"
      ]
    },
    {
      "path": "/tmp/security-plugin-manifest-retention-final-20261103T0102Z.log",
      "sha256": "359078d4a5b18856bfb57620751abfcc99e2b76d732481d93cdd3098a648511b",
      "markers": [
        "TEST_FILE_RESULT requested=2 executed=2 matched=2 status=passed head=9c5731a4e0 uncommittedPaths=2/2 provenance=stamped startedAt=2026-11-03T01:02:33.688Z childSubstituted=0 childNoticeOffsetBytes=0 skippedTests=0"
      ]
    },
    {
      "path": "/tmp/security-plugin-manifest-retention-types-final-20261103T0100Z.log",
      "sha256": "32a527efd4892ae05d6ffcf9bee30df65f91d2985fb987af7c8b9bdaba363360",
      "markers": [
        "workspaces typecheck: 2 passed, 0 failed.",
        "LINT_TSC_RESULT label=operator-core scope=files exit=0 status=clean filesRoutedAway=4 at=2026-11-03T01:00:17.436Z head=9c5731a4e0"
      ]
    }
  ],
  "populationComplete": false,
  "closureAccepted": false,
  "qualificationAdmitted": false,
  "evidenceScope": "Working-source development assertions and scoped semantic typecheck only. Not loaded-artifact custody, independent review, population closure or security acceptance. Initial combined run EXIT3 due adapter reporter finalization. Final core+adapter37PASS0SKIP EXIT0; unchanged host32PASS1preexistingSKIP group exit0 retained from original invocation.",
  "ownedResidue": [
    "EI-27726521997151204"
  ]
}
