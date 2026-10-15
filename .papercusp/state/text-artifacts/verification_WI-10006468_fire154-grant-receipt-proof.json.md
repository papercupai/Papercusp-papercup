---
rel_path: "verification/WI-10006468/fire154-grant-receipt-proof.json"
updated_at: 1791267623752
_body: "content"
---

{
  "workItem": "WI-10006468",
  "parent": "WI-10006164",
  "measuredAt": "2026-10-06T06:18:14.756Z",
  "root": "/home/marsh-office/papercupai-workspace/papercusp",
  "rootHead": "284a378d78d87f7defb3639eaccbf40f8d830dd3",
  "scope": "Local source prerequisite only; no native authenticated monetary issuer, provider invoice, full Gym acceptance or shipment proof.",
  "before": {
    "command": "PAPERCUSP_TEST_RUN_HARNESS=papercusp npm run test:file -- packages/operator-core/lib/learning-governor/registrants.test.ts",
    "log": "/tmp/fire154-grant-receipt-before.log",
    "failed": 37,
    "passed": 44,
    "skipped": 0,
    "requestedFiles": 1,
    "executedFiles": 1,
    "head": "f8c51e9e41"
  },
  "after": {
    "unit": {
      "runId": "86a912ef-3b2b-4a22-9541-5324568960e7",
      "testRunId": 20827109,
      "passed": 84,
      "failed": 0,
      "skipped": 0
    },
    "integration": {
      "command": "PAPERCUSP_TEST_RUN_HARNESS=papercusp npm run test:file -- packages/operator-core/lib/learning-governor/store.integration.test.ts",
      "log": "/tmp/fire154-grant-receipt-pg-final.log",
      "testRunId": 20827132,
      "passed": 102,
      "failed": 0,
      "skipped": 0,
      "runGroupId": null
    },
    "totalPassed": 186,
    "independentLedgerRead": "Final two ledger rows PASS/local/papercusp/dirty/root284a378d78; unit group86a912ef, PG runGroup null.",
    "types": {
      "command": "build:typecheck project=packages/operator-core scopeToFiles=true",
      "files": [
        "packages/operator-core/lib/learning-governor/registrants.ts",
        "packages/operator-core/lib/learning-governor/registrants.test.ts",
        "packages/operator-core/lib/learning-governor/store.integration.test.ts",
        "packages/operator-core/lib/transfer/live-deps.ts"
      ],
      "engine": "tsc-service",
      "named": 4,
      "checked": 35,
      "requestedErrors": 0,
      "otherErrors": 0,
      "unattributedErrors": 0,
      "compilerExitCode": 0,
      "scope": "Scoped only; not project-global or live gate."
    }
  },
  "files": [
    {
      "path": "packages/operator-core/lib/learning-governor/registrants.ts",
      "workingBlob": "cdb3ee233c77809b347dae7c79eadb99b503d469",
      "headBlob": "02e11c840134e18fc5eb992e6cdc4461c0d8ed57",
      "workingSha256": "f8c5d372c9d9681bedf529c2d87baf56071fb1cbc714365fda3e8f3d78c3b5c7"
    },
    {
      "path": "packages/operator-core/lib/learning-governor/registrants.test.ts",
      "workingBlob": "2867caa0ac8e4fb9b6aa020898767642c5b8052d",
      "headBlob": "4b74e5d933ae98465f5e72c1f01877fdf9212d2f",
      "workingSha256": "8fa12aef8a67fa3e7a9bd53c85ea7e6bb001f1ee16f9b740890c3d95f93d88b6"
    },
    {
      "path": "packages/operator-core/lib/learning-governor/store.integration.test.ts",
      "workingBlob": "6066b9f3ac7b7f7fac4d3616de750c4fa5618a7f",
      "headBlob": "a3330b5f879a88de2ef2cb4993aa68c1cb829673",
      "workingSha256": "7fde7667fa1f49cb1485e53c2069053cc95c29537a37f2411aab7989c61855b2"
    }
  ],
  "rootCause": "The governed helper converted reserve(ok:true) adapter rows into dispatched grants without confirming an OPEN matching admission.",
  "guard": "Validate one copied receipt before run. Invalid receipts dispatch no work and attempt no settlement of a possibly foreign row. Unit refusal matrix plus four actual-PG substituted-receipt controls are registered in the project's suites.",
  "limitations": [
    "List-price estimates and callback/ID labels are not provider monetary authority.",
    "Actual native judge/proposer/evaluation/manual pipeline issuer wiring remains open on WI-10006164.",
    "Old two-file run failed on an inconsistent clamping fixture and reached the foreground ceiling; its detached recovery is not final proof.",
    "All three working blobs differ from the recorded HEAD at measurement; current main/deploy unmeasured.",
    "Diff checks passed and the three final blobs matched the pre-PG manifest at final reread."
  ]
}
