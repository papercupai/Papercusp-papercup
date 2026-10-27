---
rel_path: "runtime-migration/p004-native-boundary-c5b20-20261026.json"
updated_at: 1793038841058
_body: "content"
---

{
  "schema": "bun-p004-native-boundary-source-proof-v1",
  "plan": "node-to-bun-staged-migration-2026-10-22",
  "workItem": "WI-6554700010022070",
  "owner": "su-c5b20036-1420-45e1-a14b-60fd21571af8",
  "date": "2026-10-26",
  "acceptance": false,
  "nodeRemainsActive": true,
  "sourceHeadAtCollection": "361fac9a43bc39c65e9d9f51403fee22f643acd7",
  "sourceHashes": {
    "packages/operator-core/lib/bundled-node.ts": "05736ebaac7018183054c34af1adc47d3496a7157b298c5cb4990fdd5005ee8a",
    "packages/operator-core/lib/bundled-node.test.ts": "fd6e08ef98ca6cd0bc4b16ab3aa51ade1527c9a218202162cb6f0387076a2db4",
    "packages/operator-core/lib/sync/hyperbee/substrate-boot-wrapper.ts": "3a1c61fc8e69ddffe3d8b5f667fa79d1ae550c92f86e66c375f48393d0e716c1",
    "packages/operator-core/lib/sync/hyperbee/substrate-boot-wrapper.test.ts": "b687bb505fb84ff24e5fb92c5272db55552709706a08bf5cc592b9a324b8d1b9",
    "packages/operator-core/lib/sync/hyperbee/substrate-sidecar-server.ts": "fb4f4d5ba51a1b2fac901bf7e244e276a3ade6f79ba1461ee53a1b974e72de4b",
    "packages/operator-core/lib/sync/hyperbee/substrate-runtime-boundary.test.ts": "ba6a1571650f5868976ec07da5cf43fb01baf96e03590397625e5e63f048311b"
  },
  "logs": [
    {
      "path": "/tmp/bun-c5b20-retained-node-red.log",
      "sha256": "bfb28729a4005171d4d9e4f09f696bd1726133f32f50305a840d7ab85a9a36da",
      "verdict": [
        "      Tests  1 failed | 10 passed (11)",
        "TEST_FILE_RESULT requested=1 executed=1 matched=1 status=failed head=93aa78e047 uncommittedPaths=1/1 provenance=stamped startedAt=2026-10-26T18:02:54.643Z childSubstituted=0 skippedTests=0"
      ]
    },
    {
      "path": "/tmp/bun-c5b20-retained-node-green.log",
      "sha256": "9f1c0c7524571f39edc5828ddbcb3a7e1bb47d5c8952068cd9e83f1e84b4f40b",
      "verdict": [
        "      Tests  38 passed (38)",
        "TEST_FILE_RESULT requested=2 executed=2 matched=2 status=passed head=93aa78e047 uncommittedPaths=1/2 provenance=stamped startedAt=2026-10-26T18:04:28.768Z childSubstituted=0 skippedTests=0"
      ]
    },
    {
      "path": "/tmp/bun-c5b20-substrate-routing-red.log",
      "sha256": "3298158f52f370bd957f838a6dd10df9815df41cee864cda66b977d7f0375c08",
      "verdict": [
        "      Tests  2 failed | 14 passed (16)",
        "TEST_FILE_RESULT requested=1 executed=1 matched=1 status=failed head=2af3213ef2 uncommittedPaths=1/1 provenance=unknown startedAt=2026-10-26T18:07:25.377Z childSubstituted=0 skippedTests=0"
      ]
    },
    {
      "path": "/tmp/bun-c5b20-substrate-routing-green.log",
      "sha256": "a07b535007e82b8c079944c283b4054abaf88383967b1674d44e7cd21de32cee",
      "verdict": [
        "      Tests  32 passed (32)",
        "TEST_FILE_RESULT requested=2 executed=2 matched=2 status=passed head=361fac9a43 uncommittedPaths=0/2 provenance=stamped startedAt=2026-10-26T18:09:18.791Z childSubstituted=0 skippedTests=0"
      ]
    },
    {
      "path": "/tmp/bun-c5b20-substrate-boundary.log",
      "sha256": "1d86c4372f5918bcc61d2a86c146f6d93acead72cc35095505da4c747ec16cbc",
      "verdict": [
        "      Tests  7 passed (7)",
        "TEST_FILE_RESULT requested=2 executed=2 matched=2 status=passed head=361fac9a43 uncommittedPaths=1/2 provenance=stamped startedAt=2026-10-26T18:13:44.584Z childSubstituted=0 skippedTests=0"
      ]
    },
    {
      "path": "/tmp/bun-c5b20-runtime-final-types.log",
      "sha256": "095edb392d4a77773edc130483217d5069a93f0517e2abc30faa8e3a73316a7b",
      "verdict": [
        "LINT_TSC_RESULT label=operator-core scope=files exit=0 status=clean at=2026-10-26T18:14:14.355Z head=361fac9a43"
      ]
    }
  ],
  "sourceMaps": [
    {
      "path": "/tmp/bun-c5b20-substrate-routing-green-source.json",
      "sha256": "5c8962f2823c021772c24a2c48ad29e5e145fe045565ef4679f4e54774ef54cb",
      "recordedSha": "361fac9a43bc39c65e9d9f51403fee22f643acd7",
      "worktreeDirty": true,
      "completionIntegrity": {
        "schemaVersion": 1,
        "sha256": "df415f4cb7a3a1736131189766e31576eed9aa580eccf20cb5436f00b98580f7"
      }
    },
    {
      "path": "/tmp/bun-c5b20-substrate-boundary-source.json",
      "sha256": "9c401c3965826f89fc019946f8acc7e01d7f2bc164393b8cc06afc32ea4bfb7d",
      "recordedSha": "361fac9a43bc39c65e9d9f51403fee22f643acd7",
      "worktreeDirty": true,
      "completionIntegrity": {
        "schemaVersion": 1,
        "sha256": "237c4a30fc2311fa390984804b1b07462d05fde5b9f86097466c0f06f85ec4ac"
      }
    }
  ],
  "rootCauses": [
    "Windows packaging publishes node.exe while the retained-Node resolver only searched bin/node when its parent was Bun or Tauri.",
    "Bun's optional substrate flag/fallback selected unsupported in-process UDX/RocksDB instead of the existing retained Node native role."
  ],
  "reuse": "Extended existing retained-runtime resolver and typed substrate IPC; extracted the same production control-server construction for real transport/store tests. No new service, store or protocol.",
  "results": {
    "resolverAndSelector": "38 PASS",
    "routingAndSpawn": "32 PASS",
    "realNodeAndBunIpcAndNativeStore": "7 PASS",
    "types": "Six named files clean; native exit 0",
    "skips": 0,
    "childSubstitutions": 0,
    "activationAudit": 7,
    "decision": "D-009"
  },
  "limits": [
    "Local source proof, not installed Windows or signed immutable candidate acceptance.",
    "Real IPC storage test proves Node/Bun transport, HLC/UTF-8 persistence and reopen plus unknown-method rejection; not swarm or full projection/user parity.",
    "Source maps are preserved with dirty-tree/native-custody partial markers; do not assert complete dependency/native/process closure.",
    "Operational application canary, owner fencing, immutable custody, full platform matrix, canonical independent acceptance, soak/rollback and final shipment remain open."
  ]
}
