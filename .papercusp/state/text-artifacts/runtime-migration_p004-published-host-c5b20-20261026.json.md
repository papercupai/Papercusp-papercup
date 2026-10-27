---
rel_path: "runtime-migration/p004-published-host-c5b20-20261026.json"
updated_at: 1793043453602
_body: "content"
---

{
  "schemaVersion": 1,
  "scope": "Local maintained published-host integration proof, not final candidate or default acceptance",
  "workItem": "WI-6554700010022070",
  "fixtureBug": "EI-27070585373455759",
  "testRunId": "22253659",
  "receiptId": "f5fcc583-f53e-4f3d-a552-13f3291dd206",
  "result": {
    "passed": 2,
    "failed": 0,
    "skipped": 0,
    "status": "pass",
    "childSubstituted": 0,
    "nativeCustody": "partial",
    "outerShellExit": "unrecorded: .exit absent; authoritative test receipt inserted and TEST_FILE_RESULT passed"
  },
  "hostProofs": [
    {
      "runtime": {
        "name": "node",
        "pid": 1924784,
        "privatePg": true
      },
      "cleanup": {
        "kind": "isolated-runtime-cleanup",
        "stage": "complete",
        "elapsedMs": 2016,
        "supervisorPid": 1903695,
        "workspace": "test-runtime-6fe4d3a7-484",
        "runtimeRoot": "/tmp/pcv/papercusp-test-runtime-pz2ymq",
        "dataDir": "/tmp/pcv/papercusp-test-pg-MLouwV",
        "pgPort": 39987,
        "runtimeRemoved": true,
        "pgDataRemoved": true
      },
      "evidenceDir": "/tmp/bun-c5b20-host-published-20261026-1928-artifacts/application-host-node-aY0qrN",
      "entrySha256": "dca0f1f526db51cc7c44fbb10e3c832c7eaa9f60e68595f18c14a408a03a8683"
    },
    {
      "runtime": {
        "name": "bun",
        "pid": 1990849,
        "privatePg": true
      },
      "cleanup": {
        "kind": "isolated-runtime-cleanup",
        "stage": "complete",
        "elapsedMs": 3286,
        "supervisorPid": 1972452,
        "workspace": "test-runtime-54da9e0c-6ec",
        "runtimeRoot": "/tmp/pcv/papercusp-test-runtime-ZNV4pA",
        "dataDir": "/tmp/pcv/papercusp-test-pg-iOzGp7",
        "pgPort": 34655,
        "runtimeRemoved": true,
        "pgDataRemoved": true
      },
      "evidenceDir": "/tmp/bun-c5b20-host-published-20261026-1928-artifacts/application-host-bun-xdyuT6",
      "entrySha256": "dca0f1f526db51cc7c44fbb10e3c832c7eaa9f60e68595f18c14a408a03a8683"
    }
  ],
  "interpreters": [
    {
      "name": "node",
      "execPath": "/home/marsh-office/.local/node25/bin/node",
      "version": "v25.9.0",
      "platform": "linux",
      "arch": "x64",
      "executable": {
        "path": "/home/marsh-office/.local/node25/bin/node",
        "bytes": 129006184,
        "sha256": "7fd113446e9171a28885227b3c275ff965b2fd1f45ccf1fb3a1c20308f34e627"
      }
    },
    {
      "name": "bun",
      "execPath": "/home/marsh-office/.bun/bin/bun",
      "version": "1.3.14",
      "platform": "linux",
      "arch": "x64",
      "executable": {
        "path": "/home/marsh-office/.bun/bin/bun",
        "bytes": 92752752,
        "sha256": "9fd36f87e4b90b07632b987a2e4ec81ca15a62c81bf983190cea6d715be2ad74"
      }
    }
  ],
  "files": [
    {
      "path": "/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/application-host-runtime.integration.test.ts",
      "bytes": 7627,
      "sha256": "846f2b41e959b17f26dbd0ac6c731d94505928c29abcb3ad002a778641f586de"
    },
    {
      "path": "/tmp/bun-c5b20-host-published-20261026-1928/serve.mjs",
      "bytes": 85022071,
      "sha256": "dca0f1f526db51cc7c44fbb10e3c832c7eaa9f60e68595f18c14a408a03a8683"
    },
    {
      "path": "/tmp/bun-c5b20-host-published-20261026-1928-build.log",
      "bytes": 38388,
      "sha256": "62dc12762c2ff431dd6dc948678f6a08de1c63f66b773bdedf96470965f599b1"
    },
    {
      "path": "/tmp/bun-c5b20-host-published-20261026-1928.log",
      "bytes": 25564,
      "sha256": "f83164a3fb051240f4ce79bbeff005ccca81dd0cd883357ba171d6ce862befd0"
    },
    {
      "path": "/tmp/bun-c5b20-host-published-20261026-1928-receipt.jsonl",
      "bytes": 2674,
      "sha256": "b3243d813a71a492d3f250b9b54405f57972de02ecebeee0666794aa5f155512"
    },
    {
      "path": "/tmp/bun-c5b20-host-published-20261026-1928-source.json",
      "bytes": 73601,
      "sha256": "325847230444f6b3d190f67566c0eeaaf1d656774eddfcb8288abcd9dd3ede48"
    },
    {
      "path": "/tmp/bun-c5b20-host-published-20261026-1928-source-result.jsonl",
      "bytes": 388,
      "sha256": "60aa07a19630a737cebc82344d406eca4fcf4021a63c2c6b611f4731046b324a"
    },
    {
      "path": "/tmp/bun-c5b20-host-published-20261026-1928-types.log",
      "bytes": 8942,
      "sha256": "d73e26eb2e5467098a7fecaf6e90e05c4ea3396d8de1994a5834c74d0255f869"
    },
    {
      "path": "/tmp/bun-c5b20-host-published-20261026-1928-artifacts/application-host-node-aY0qrN/stdout.log",
      "bytes": 813603,
      "sha256": "24aa48dd5bdd0b7966432e980b22227e236335a165e72bc3a37fdc6d387e606f"
    },
    {
      "path": "/tmp/bun-c5b20-host-published-20261026-1928-artifacts/application-host-node-aY0qrN/stderr.log",
      "bytes": 0,
      "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    },
    {
      "path": "/tmp/bun-c5b20-host-published-20261026-1928-artifacts/application-host-bun-xdyuT6/stdout.log",
      "bytes": 813935,
      "sha256": "cb6bc3528f77a201d11d64cc044f42989524b765fe9949188d942ceb1245ed7c"
    },
    {
      "path": "/tmp/bun-c5b20-host-published-20261026-1928-artifacts/application-host-bun-xdyuT6/stderr.log",
      "bytes": 0,
      "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    }
  ],
  "sourceHead": "69d65a470984ac49f56e52d0a0632173db9254ee",
  "sourceState": "named test dirty during run; bundle fixed by byte hash; import closure not claimed immutable",
  "testRouterFinal": "TEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed head=69d65a4709 uncommittedPaths=1/1 provenance=stamped startedAt=2026-10-26T19:31:12.175Z childSubstituted=0 skippedTests=0",
  "typecheckFinal": "LINT_TSC_RESULT label=operator-core scope=files exit=0 status=clean at=2026-10-26T19:27:54.068Z head=69d65a4709",
  "limits": [
    "Bun executable is 1.3.14; configured candidate pin may differ",
    "No live default flip",
    "No signed packaged artifact or full platform matrix",
    "No final canary/soak/rollback/shipment acceptance",
    "Partial native custody retained"
  ]
}
