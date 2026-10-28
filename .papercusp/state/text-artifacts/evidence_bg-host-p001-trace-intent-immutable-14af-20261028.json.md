---
rel_path: "evidence/bg-host-p001-trace-intent-immutable-14af-20261028.json"
updated_at: 1793214843674
_body: "content"
---

{
  "scope": "Committed isolated local guard and one real compilation only; P001/runtime/parent/shipment incomplete",
  "selection": {
    "ref": "14af3f59acfd229084ad1c68be1a13054c7d5d8f",
    "inputs": [
      {
        "path": "scripts/source-preview.mjs",
        "sha256": "3473ecddc3245357b8d18da481989464d6899ca7f8491738c6478b0c538350dc",
        "matchesWorking": true
      },
      {
        "path": "scripts/source-preview.d.mts",
        "sha256": "f70da70d02482e05d12b3588d49c656899cd7682df043f046a6a2b2f2b252246",
        "matchesWorking": true
      },
      {
        "path": "packages/operator-core/lib/source-preview-export.test.ts",
        "sha256": "aa62e1519a615d02949c58d7295f1e87850f6cb887a366cbe0b2edcbeb0b0723",
        "matchesWorking": true
      }
    ]
  },
  "exit": {
    "status": 0,
    "signal": null,
    "error": null
  },
  "testRunId": 22564250,
  "counts": {
    "passed": 2,
    "failed": 0,
    "filtered": 409
  },
  "provenance": "TEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed head=14af3f59ac uncommittedPaths=0/1 provenance=stamped startedAt=2026-10-28T19:06:57.151Z childSubstituted=0 skippedTests=409",
  "keptRoot": "/tmp/pcv/papercusp-lint-as-committed-14af3f59ac-6dZkPv",
  "phases": [
    {
      "phase": "bg.compiler.before-build",
      "durationMs": 1483
    },
    {
      "phase": "bg.compiler.node",
      "durationMs": 313
    },
    {
      "phase": "bg.compiler.metadata",
      "durationMs": 0
    },
    {
      "phase": "bg.compiler.binary",
      "durationMs": 34
    },
    {
      "phase": "bg.compiler.toolchain-files",
      "durationMs": 15
    },
    {
      "phase": "bg.compiler.custody",
      "durationMs": 1159
    },
    {
      "phase": "bg.compiler.import",
      "durationMs": 28
    },
    {
      "phase": "bg.compiler.build",
      "durationMs": 55
    },
    {
      "phase": "bg.compiler.verify",
      "durationMs": 2545
    },
    {
      "phase": "bg.compiler.output",
      "durationMs": 4
    },
    {
      "phase": "bg.compiler.stop",
      "durationMs": 3
    }
  ],
  "log": "/tmp/bg-host-p001-trace-immutable-ledger-20261028.log",
  "logSha256": "8fcc5bdfa0b46c60f29b043d7fcc3b4693587394674bba29ea07e4af89bb9d79",
  "caseRecords": [
    {
      "case_key": "BG inherited manifest and original source boundaries > BG compiler phase trace retains original diagnostic intent after environment replacement",
      "status": "pass",
      "duration_ms": 9
    },
    {
      "case_key": "BG inherited manifest and original source boundaries > compiles exact maintained host switches using private real esbuild and retains original custody",
      "status": "pass",
      "duration_ms": 13377
    }
  ]
}
