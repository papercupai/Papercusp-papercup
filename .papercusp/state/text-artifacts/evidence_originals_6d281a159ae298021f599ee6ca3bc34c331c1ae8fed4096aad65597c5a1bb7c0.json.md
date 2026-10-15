---
rel_path: "evidence/originals/6d281a159ae298021f599ee6ca3bc34c331c1ae8fed4096aad65597c5a1bb7c0.json"
updated_at: 1790936181224
_body: "content"
---

{
  "schemaVersion": 1,
  "purpose": "Qualify R19 executed private content-lint caller/resource evidence; not P011 live acceptance",
  "rawReceipt": {
    "path": "docs/evidence/papercusp-oct1-p011-content-lint-caller-r19-2026-10-02.json",
    "bytes": 32644,
    "sha256": "1dd1c8d069495999dc7c78a5338f7a933efd31a4767a9607831f17f645734367"
  },
  "testReceipt": {
    "ledgerId": 20487239,
    "harness": "papercusp",
    "status": "pass",
    "passed": 2,
    "failed": 0,
    "filteredSkips": 4,
    "logPath": "/tmp/su-7db4f-p011-caller-r19.log",
    "logSha256": "3da533126abcacddfce2e40299e6937172cabaa91d8ec6f5cb30e0496d38b8d1",
    "nativeExitCode": 0,
    "sourceCommit": "98f502be2781356b14b543d1fa49021e40b2338d",
    "dirtyTest": true,
    "routerProvenance": "unknown after HEAD movement"
  },
  "plane": "current-source-private-content-lint-http-fixture",
  "compiledGraph": [
    {
      "path": "packages/operator-core/lib/content-lint/esbuild-transform.ts",
      "sha256": "f57a776a8af87c95fa614855921eb7981012f063aac5159269433805baa65796"
    },
    {
      "path": "<private-request-fixture>",
      "sha256": "85a37382074d3607c4959aeabc17a54b0e7b74e7af245145510bfea851b7eddb"
    }
  ],
  "compiledBundleSha256": "918905cf8bd4c61ed40f538c7dc60eaeec72190f5bcd593b506ee84769fedfe1",
  "namedCurrentness": [
    {
      "path": "packages/operator-core/lib/content-lint/esbuild-transform.ts",
      "atRunSha256": "f57a776a8af87c95fa614855921eb7981012f063aac5159269433805baa65796",
      "nowSha256": "f57a776a8af87c95fa614855921eb7981012f063aac5159269433805baa65796",
      "matches": true
    }
  ],
  "postRunReferences": [
    {
      "path": "packages/operator-core/lib/service-memory-attribution.integration.test.ts",
      "sha256": "7b28f4097bb7a701b31d92a6950648ce4b3414b577c37dd4a1a00a7d25412afd",
      "timing": "post-run only; not execution-source proof"
    },
    {
      "path": "scripts/cdp-inspector.mjs",
      "sha256": "e6f6d3888d527ebfee97a62dc83111e0bf01997e26cfb87512db86fe8b2df91c",
      "timing": "post-run only; not execution-source proof"
    },
    {
      "path": "scripts/cdp-inspector.d.mts",
      "sha256": "f2b90d4e5ae8fe658dafbf91f3df7d4386ef5869d70499280fe637a8813a97f1",
      "timing": "post-run only; not execution-source proof"
    },
    {
      "path": "node_modules/esbuild/lib/main.js",
      "sha256": "b090fe57c79c677256a242703ea07bb2191eced357bece2f9a25539443da070c",
      "timing": "post-run only; not execution-source proof"
    }
  ],
  "resources": {
    "compiler": {
      "path": "/home/marsh-office/papercupai-workspace/papercusp/node_modules/@esbuild/linux-x64/bin/esbuild",
      "sha256": "fd49340cbb5f7ca3ce6f313db78d056de21f07338135ec8dfad63294a304fd2c"
    },
    "sampling": "5 parent V8/heap/external/PSS plus executable-identified direct-child samples per mode",
    "inputSchedule": "same eleven scheduled requests per mode: warm, three concurrent three-request source windows, invalid-source guard outside matched resource cohort",
    "trace": {
      "controlCalls": 0,
      "transformCalls": 9,
      "caller": "findEsbuildTransformError",
      "debuggerPauses": [
        0,
        0
      ]
    },
    "parentPssKiB": {
      "control": [
        13241,
        15819,
        16943,
        18595,
        18608
      ],
      "transform": [
        13213,
        18004,
        20153,
        20508,
        20514
      ]
    },
    "compilerPssKiB": {
      "control": [
        4849,
        4849,
        4861,
        4861,
        4937
      ],
      "transform": [
        4526,
        11501,
        12821,
        12684,
        12684
      ]
    },
    "hostReaped": [
      true,
      true
    ],
    "unreaped": [
      [],
      []
    ]
  },
  "verification": {
    "scopedTypeErrors": 0,
    "method": "TypeScript createProgram for exact integration test; reported only diagnostics attributed to that file",
    "wholeGraphTypecheck": "not measured",
    "completeExecutedDependencySourceCurrentness": "unknown; esbuild JS and inspector/test source were not fingerprinted at execution"
  },
  "acceptance": {
    "PERF-OCT1-P011-MEMORY": "partial fixture only; live layer not fulfilled",
    "historical4_2GiBCaller": "unknown",
    "productionMemoryReduction": "not established",
    "R8R9": "open",
    "shipment": "open"
  },
  "limitations": [
    "Current application source compiled into a private request fixture; not the deployed operator runtime.",
    "One-second idle is bounded fixture evidence, not an ordinary production idle baseline.",
    "V8 malloced/external counters and executable PSS are measured separately; no total native allocation estimate.",
    "Named exercised content-lint caller does not attribute the historical 4.2 GiB production census.",
    "Compiler trace adds bounded diagnostic overhead; control receives identical source bytes without transform work."
  ],
  "priorFailedAttempts": {
    "firstWarm500": 20487182,
    "R16": "/tmp/su-7db4f-p011-caller-r16.log",
    "R17": "/tmp/su-7db4f-p011-caller-r17.log",
    "R18": "docs/evidence/papercusp-oct1-p011-content-lint-caller-r18-2026-10-02.json"
  },
  "successorNext": "Exercise actual serving current-build compiler path with private identity/data and independent equivalent control; do not repeat this fixture merely to reconstruct its saved proof."
}

