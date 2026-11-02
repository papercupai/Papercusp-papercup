---
rel_path: "runtime-migration/p006-baseline-sdk-compat-repair-0dcd3-20261102.json"
updated_at: 1793610088528
_body: "content"
---

{
  "schemaVersion": 1,
  "workItem": "EI-27664931934067649",
  "rootCause": "Current exact-source producer required a modern exported SDK loader table from a retained d740/c864 rollback release that predates it; legacy computed imports also require a shipped SDK dependency closure.",
  "sourcePins": {
    "superproject": "d740fc3802877d1c8c3b1068768681ee32ef0025",
    "desktop": "c864f7a1"
  },
  "filesChanged": [
    "papercusp-desktop/bin/build-desktop-sidecar.sh",
    "papercusp-desktop/bin/check-ptool-sdk-bundle.mjs",
    "papercusp-desktop/test/check-ptool-sdk-bundle.test.js"
  ],
  "tests": {
    "command": "node --test --test-global-setup=test/monorepo-host-preflight.mjs test/check-ptool-sdk-bundle.test.js",
    "cwd": "papercusp-desktop",
    "passed": 9,
    "failed": 0,
    "skipped": 0,
    "exitCode": 0
  },
  "actualBaseline": {
    "taskId": "0mvz12ikb17wil4eaea",
    "exitCode": 0,
    "log": ".papercusp/scratch/bash-5d1e0509-a6d.log",
    "qualificationRoot": "/mnt/data/tmp/bun-p006-sdk-baseline-0dcd3-20261102.kXJP5K",
    "bundleSha256": "64801ac46cd3a6aac6458f31e00b3b51b85d4a10043ec9a70514405f53103ee7",
    "standalone": "fails missing table",
    "runtimeClosure": "three real SDK loads and CLI bootstrap pass",
    "copiedPackages": 82,
    "missingPackages": 0,
    "bundleUnchanged": true
  },
  "guards": [
    "modern computed import fails even when runtime closure supplied",
    "missing legacy transitive zod fails isolated qualification",
    "missing table without recognized legacy importer fails",
    "CLI bootstrap failure fails qualification"
  ],
  "limits": "SDK packaging precondition verified. Full baseline producer, installed upgrade/rollback and migration shipment remain open under P006."
}
