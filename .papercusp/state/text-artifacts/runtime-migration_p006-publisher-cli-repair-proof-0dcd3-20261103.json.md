---
rel_path: "runtime-migration/p006-publisher-cli-repair-proof-0dcd3-20261103.json"
updated_at: 1793683867625
_body: "content"
---

{
  "schemaVersion": 1,
  "scope": "Current helper stage CLI and real publisher regression, not frozen8dfbd/candidate/wholegraph qualification",
  "rootCause": "Frozen8dfbd publisher invokes stage but same-cut helper accepts no stage command",
  "existingFix": "2195f8598b3cd67cec38439362ff8b00d00a9a23",
  "fullSuite": {
    "task": "0mw08lphx4dp1ol1her",
    "passed": 12,
    "skipped": 0,
    "exitCode": 0,
    "provenance": "unknown: moving staging"
  },
  "focusedCase": {
    "task": "0mw08vq1dp66r36g1ch",
    "passed": 1,
    "notSelected": 11,
    "exitCode": 0,
    "nativeReason": "passed",
    "unhandled": 0
  },
  "sourceMap": {
    "path": "/mnt/data/tmp/bun-p006-publisher-source-map-0dcd3-20261103.json",
    "sha256": "43b4b7843ee677dd3ad5a9a59d5fbbf1622ad10a25d0c9dda8419c90ded0cf1a",
    "status": "stable",
    "inputsCaptured": true,
    "sources": [
      {
        "path": "apps/operator/bin/release/dependency-generation-verifier.mjs",
        "sha256": "50ac673abd3a9b68e0a5e6b38c6ccb1c8b0d30192c6292f607fc56e724fb81d2",
        "basis": "vite-pre-transform",
        "currentSha256": "50ac673abd3a9b68e0a5e6b38c6ccb1c8b0d30192c6292f607fc56e724fb81d2"
      },
      {
        "path": "apps/operator/lib/release/dependency-generation-verifier.test.ts",
        "sha256": "ff07417b8c7b59cd80b735b305f73a64c1b778118a25dc04e3b5c0d2661b5bf4",
        "basis": "vite-pre-transform",
        "currentSha256": "ff07417b8c7b59cd80b735b305f73a64c1b778118a25dc04e3b5c0d2661b5bf4"
      },
      {
        "path": "packages/operator-core/lib/dependency-generation-proof.ts",
        "sha256": "349a6a6c67414628f76c7170db94c35fbba018a08f4b1350188fab22bca28292",
        "basis": "vite-pre-transform",
        "currentSha256": "349a6a6c67414628f76c7170db94c35fbba018a08f4b1350188fab22bca28292"
      },
      {
        "path": "scripts/source-preview.mjs",
        "sha256": "a229463bb95e0b2909bea35be76d460f205f059b776c47d7300d8150a1b78b52",
        "basis": "vite-pre-transform",
        "currentSha256": "a229463bb95e0b2909bea35be76d460f205f059b776c47d7300d8150a1b78b52"
      }
    ],
    "opaqueReasons": [
      "child-process",
      "git-metadata",
      "worker-runtime-unavailable",
      "config-deps-unavailable"
    ]
  },
  "logs": [
    ".papercusp/scratch/bash-47e1ec38-411.log",
    ".papercusp/scratch/bash-2f950998-7c0.log",
    ".papercusp/scratch/bash-f01d1fe3-402.log"
  ]
}

