---
rel_path: "evidence/originals/2d47a67afab7af89d236e74c1187b5fc9984f262ae8306ffddc3708ff3b3e843.json"
updated_at: 1791229638195
_body: "content"
---

{
  "schemaVersion": "p011-weak-phase-preflight-qualification-v1",
  "measuredAt": "2026-10-05T15:24:44.562712+00:00",
  "nativeSession": "01a10c92-0eaa-7531-93db-3177d5767f75",
  "ownerId": "su-7db4feb8-04cb-46ce-80c2-844aa23006d2",
  "workItems": [
    "WI-10006007",
    "WI-10005966"
  ],
  "plane": "canonical local tests and typechecks; no deployed or full P011 acceptance",
  "reuse": "Extended existing pinned heap reader and canonical inspector tests; reused existing diagnostic error field and private log archive.",
  "behavior": {
    "beforeSnapshot": "Each exact selected query records decodedResult/resolvedRows/responseValue WeakRef registration via bounded data properties. Any missing phase refuses before capture.",
    "noninterference": "Selection never dereferences targets, invokes getters/proxy traps, or copies row objects. Presence does not prove liveness; collected targets remain post-snapshot gaps.",
    "failureEvidence": "Existing diagnostic field records pg-weak-phase-presence and complete bounded registryBeforeSnapshot, persisted by the maintained cohort error handler."
  },
  "tests": {
    "command": "PAPERCUSP_TEST_RUN_HARNESS=papercusp npm run test:file -- packages/operator-core/lib/cdp-inspector.test.ts",
    "exitCode": 0,
    "passed": 39,
    "skipped": 0,
    "testRunId": 20703386,
    "workspace": "papercusp-workspace",
    "harness": "papercusp",
    "log": {
      "path": ".papercusp/logs/cohort-b8a8d77147475f0e18ce508e6270d06fb56c8a1509fb29e8299bf016324d57a3.log",
      "bytes": 4359,
      "sha256": "b8a8d77147475f0e18ce508e6270d06fb56c8a1509fb29e8299bf016324d57a3"
    },
    "newCases": [
      "missing decodedResult",
      "missing resolvedRows",
      "missing responseValue",
      "phase accessor refused without call",
      "proxy phase refused without trap",
      "registered weak phase proceeds without dereference; subsequently collected target remains a gap"
    ]
  },
  "types": {
    "operator": {
      "command": "PAPERCUSP_TSC_SERVICE=0 npm run lint:tsc -- --files=packages/operator-core/lib/cdp-inspector.test.ts,packages/operator-core/lib/service-memory-attribution.integration.test.ts,packages/operator-core/lib/service-memory-baseline-evidence.integration.test.ts --all-errors",
      "exitCode": 0,
      "namedPathsClean": true,
      "globalProjectClean": false,
      "scope": "Three exact named test paths; full CLI compile has diagnostics elsewhere, already recorded by its standing-red mechanism.",
      "log": {
        "path": ".papercusp/logs/cohort-d2f17829a04bff879bc495df566e197e74a5f8f14034f3b4db47ba4ff505424b.log",
        "bytes": 5630,
        "sha256": "d2f17829a04bff879bc495df566e197e74a5f8f14034f3b4db47ba4ff505424b"
      }
    },
    "database": {
      "command": "bash scripts/pc-heavy.sh npm --workspace @papercusp/db-org run typecheck -- --listFiles",
      "exitCode": 0,
      "requestedTest": "libs/papercusp/libs/db/src/postgres-result-diagnostics.test.ts",
      "requestedTestObservedInProgram": true,
      "requestedDiagnosticLines": [],
      "log": {
        "path": ".papercusp/logs/cohort-7f1c24d9c408add81dfa4be321bb407f9e8e5fb270ee56beb7d9aa8a30a50998.log",
        "bytes": 92910,
        "sha256": "7f1c24d9c408add81dfa4be321bb407f9e8e5fb270ee56beb7d9aa8a30a50998"
      }
    },
    "historicalTypeGap": "Old source-only typecheck is preserved as historical evidence. These new CLI results supply actual requested test-file coverage, not a retroactive expansion of that old proof."
  },
  "sources": [
    {
      "path": "scripts/cdp-inspector.mjs",
      "bytes": 51171,
      "sha256": "3efdd779140982d3867cc55886b14168a43cb309166920a2951e68240c2736bf"
    },
    {
      "path": "scripts/cdp-inspector.d.mts",
      "bytes": 14412,
      "sha256": "d323300e713cc5bcf9960fc76107c5c688782aec4db854627adfc5e387021e4a"
    },
    {
      "path": "packages/operator-core/lib/cdp-inspector.test.ts",
      "bytes": 58632,
      "sha256": "6ef95cd8875ebdade0f679d1fc2963ec7bacff67af6900fe2e484155d315c900"
    },
    {
      "path": "libs/papercusp/libs/db/src/acquire-registry.ts",
      "bytes": 29262,
      "sha256": "d72752978db0773b83d5347bcb39f5bbae33a997754ac8abf9354fe11222f6ea"
    },
    {
      "path": "libs/papercusp/libs/db/src/postgres-result-diagnostics.test.ts",
      "bytes": 36448,
      "sha256": "ecff887e9b9aa8b98cfddf0d1f1b99ccf78b75548ca799563574205de4016e40"
    },
    {
      "path": "packages/operator-core/lib/service-memory-attribution.integration.test.ts",
      "bytes": 201224,
      "sha256": "bba36ba90ea41a6a6edc813f00098e09aa55cbe5db8ee5e6107b371ebf65b186"
    },
    {
      "path": "packages/operator-core/lib/service-memory-baseline-evidence.integration.test.ts",
      "bytes": 53048,
      "sha256": "a6686c15f7307dfcd77915534e0554ea09d398ff15384cd58b63ae42777f55f2"
    }
  ],
  "decoderRestore": {
    "revision": "05edd8131a77790ab0e7bce2eedf5770d6bb83ae",
    "version": "v8-heap-cli 0.1.0",
    "executable": {
      "path": ".heap-retainers-cargo-target/decoder-control/bin/v8-heap",
      "bytes": 1618440,
      "sha256": "2697f0cf15785272b24e08e0bcec0a43c8fd5f2ba4fec8a4ffda1d89d8f7ff24"
    },
    "byteIdenticalToPriorDecoder": true,
    "priorSha256": "2697f0cf15785272b24e08e0bcec0a43c8fd5f2ba4fec8a4ffda1d89d8f7ff24",
    "log": {
      "path": ".papercusp/logs/cohort-dd6d6591dc5d5f02ecbb9192df4fcb8c3b2eeab1f70d01e07c35866784360194.log",
      "bytes": 7918,
      "sha256": "dd6d6591dc5d5f02ecbb9192df4fcb8c3b2eeab1f70d01e07c35866784360194"
    },
    "storage": "Existing Cargo artifact tree replaces expired temporary installation."
  },
  "historicalQualification": {
    "path": "docs/evidence/papercusp-oct1-p011-request-retainers-r2-qualification-2026-10-03.json",
    "bytes": 14623,
    "sha256": "08549b5ca89fd68e06487dd62c75dc9cef2f0a4a5d2c9900beeb28071e57b942"
  },
  "acceptanceLimits": [
    "Historical R1/R2 producer failures remain unchanged.",
    "One new R3 is in flight; no result is claimed here.",
    "Current serving runtime lacks the new inspector bytes; isolated compiled current-build result cannot establish deployed acceptance.",
    "P011@2/D021, production retained-owner/worker-clone/native-physical acceptance, independent acceptance and shipment remain open."
  ]
}

